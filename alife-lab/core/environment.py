"""core/environment.py — Thermodynamic Resource Physics.

The concrete :class:`Substrate` (see ``core/vm.py``) that every
:class:`~core.vm.Thread` actually executes against: a toroidal flat memory
lattice, a continuous resource-diffusion grid organisms must draw local
potential energy from to fuel CPU cycles, thread-safe write-collision
arbitration, and deallocation of exhausted/illegal organisms back into raw
background noise.

There is deliberately no "food item" concept anywhere in this module —
energy is a continuous scalar field over the same coordinate space as the
genomes themselves, exactly like the spec requires.

Design notes
------------
* **Toroidal addressing.** The memory lattice wraps at both edges (a
  torus), so diffusion, allocation search, and genome wraparound all use
  modulo arithmetic uniformly. This avoids any special-cased edge/boundary
  logic and keeps every coordinate topologically equivalent.
* **Collision priority.** When two threads' writes target the same
  coordinate, the resident with the *higher current energy* wins; the
  loser's write is silently rejected (see :meth:`Environment.write_byte`).
  All mutation of the shared ``owner``/``memory`` arrays happens under a
  single :class:`threading.Lock`, satisfying the "thread-safe" requirement
  even though the reference round-robin scheduler in :meth:`Environment.step`
  is itself single-threaded — the lock is what makes it safe to later move
  execution onto a real thread/process pool without touching this module.
* **Allocation locality.** :meth:`Environment.request_allocation` first
  tries the two cells immediately touching the parent's own genome, then
  searches a bounded neighborhood (``EnvironmentConfig.local_search_radius``
  genome-lengths on each side) for the *nearest* free slot before resorting
  to a uniformly random free position anywhere in the universe. Without
  this middle tier, a colony gets exactly one generation of adjacent growth
  before every later offspring is scattered far from its own kin — which
  starves lineages of the chance to ever accumulate contiguous territory.
* **Bounded random window probing before the exhaustive global scan.**
  Once a colony's local neighborhood saturates, the global fallback above
  is reached on a growing fraction of every ``ALLOC`` call as population
  scales up. A handful of randomly-positioned windows
  (:data:`GLOBAL_ALLOCATION_PROBE_WINDOWS` of them,
  :data:`GLOBAL_ALLOCATION_PROBE_WINDOW_SIZE` cells each) are scanned with
  the same sliding-window-sum technique as the local search first; the
  exhaustive scan only runs if every one of those misses.
* **Caching "no room" so a real fragmentation ceiling doesn't get
  re-discovered from scratch on every call.** At steady-state population,
  the universe routinely has plenty of free *cells* in aggregate but no
  single contiguous free *run* as long as a genome — classic external
  fragmentation, the same pathology a heap allocator can suffer from. When
  that's the actual state of the world, every search tier above (local,
  windowed, *and* exhaustive) is doomed to fail honestly, and re-running
  all of them on every single ``ALLOC`` call was, empirically, the
  dominant cost of the entire simulation once population reached the low
  thousands — far more than the per-cycle CPU-execution loop itself.
  :attr:`Environment._no_room_for_length` records the smallest length the
  exhaustive scan has most recently confirmed has no free run anywhere;
  since a free run long enough for length ``L`` is necessarily long
  enough for every shorter length too, "no room for ``L``" implies "no
  room for anything >= ``L``" as well, so later calls requesting such a
  length skip straight to failure. The only thing that can ever make a
  longer run newly possible is freeing memory, so :meth:`Environment._reclaim`
  clears the cache the moment any organism dies.
* **Copy fidelity.** Mutation is modeled here, not in the VM: every
  committed write has a small independent chance
  (``EnvironmentConfig.mutation_rate``) of being corrupted to a random
  byte before it lands, representing thermal noise acting on the physical
  write process. This is the sole source of genetic novelty in the lab.
* **Spontaneous abiogenesis probes.** Raw noise is otherwise completely
  inert — nothing ever executes it. Each cycle the environment opens a
  small number of independent "probe" CPU threads at random *unclaimed*
  coordinates (:meth:`Environment._spawn_probe_threads`), each interpreting
  whatever raw bytes happen to sit there as a genome. This is what actually
  gives the Pure Noise Sector a chance — vanishingly small, as it should be
  — at producing a self-sustaining replicator, instead of noise being
  permanently decorative.
* **Senescence (background mortality).** A population that fully occupies
  every contiguous run the memory lattice can offer reaches a state where
  nobody has room to reproduce *and* every survivor's energy income/expense
  has settled into balance, so nobody dies either — turnover, and with it
  all further mutation and speciation, halts completely. Every living
  thread loses a small fixed amount of energy each cycle
  (``EnvironmentConfig.senescence_rate``), independent of whatever
  instruction it happened to execute, guaranteeing that energy balance
  alone is never a stable equilibrium: eventually every organism dies of
  old age, freeing its memory and re-opening the fragmentation/reproduction
  cycle for its neighbors. Applied in :meth:`Environment.step`, not
  :mod:`core.vm`, to keep it a property of the environment's physics
  rather than the CPU substrate.
* **Task bonuses.** ``core.vm`` decides *whether* an IO_OUT matched a task
  (substrate-agnostic CPU semantics) but deliberately knows nothing about
  energy rewards; :meth:`Environment._award_task_bonus` decides *how
  much*. The payout reuses SHARE's existing negative-``harvest_energy``
  deposit convention — it lands in the resource field at the rewarded
  thread's own address rather than being added to its energy balance
  directly — so task rewards stay inside the same single thermodynamic
  field every other energy transaction in the lab goes through, instead
  of becoming a second, harvest-bypassing currency.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

import numpy as np

from core.vm import (
    CPUCore,
    EXHAUSTION_THRESHOLD,
    EnergyExhaustionError,
    ExecutionResult,
    Thread,
)

#: Strain codes stored in Environment.strain for cheap vectorized rendering.
STRAIN_NONE = 0
STRAIN_SEED = 1
STRAIN_NOISE = 2

#: How many randomly-positioned windows Environment.request_allocation
#: scans before resorting to an exhaustive O(universe size) scan, and how
#: large each one is. See the "Allocation locality" design note below.
GLOBAL_ALLOCATION_PROBE_WINDOWS = 4
GLOBAL_ALLOCATION_PROBE_WINDOW_SIZE = 1024

_STRAIN_NAME_TO_CODE = {"seed": STRAIN_SEED, "noise": STRAIN_NOISE}


@dataclass
class EnvironmentConfig:
    """Tunable physical constants of the simulated universe."""

    width: int = 256
    height: int = 256
    baseline_resource: float = 4.0
    max_resource: float = 32.0
    diffusion_rate: float = 0.15
    regen_rate: float = 0.02
    initial_energy: float = 60.0
    offspring_energy_share: float = 0.5
    mutation_rate: float = 0.0025
    probe_spawn_count: int = 4
    probe_genome_length: int = 24
    local_search_radius: int = 12
    senescence_rate: float = 0.0
    task_bonus_energy: float = 0.0
    #: Fraction of the lattice that may be claimed before
    #: :meth:`Environment.request_allocation` refuses all new allocations,
    #: regardless of how much free space remains. Diagnostics on a tuned
    #: long run showed occupancy settling near ~90% almost immediately and
    #: staying there: at that density, free cells exist but are fragmented
    #: into runs shorter than a genome almost everywhere, so ALLOC failure
    #: rates climb into the millions-per-5000-cycles range while the
    #: population sits one mutation away from a runaway illegal-opcode
    #: death cascade (a freed cell triggers a birth burst, ~5-6% of which
    #: are fatally mutated, feeding the cascade). Capping occupancy well
    #: below that gridlock threshold keeps enough slack space that
    #: genome-length free runs stay findable, so the gridlock never forms.
    max_occupancy_fraction: float = 0.65
    #: Starting energy granted to a spontaneous abiogenesis probe. Kept as a
    #: small fixed budget — deliberately *not* a multiple of
    #: ``baseline_resource`` — so that retuning the resource field's richness
    #: never silently inflates how long pure-noise probes survive. A probe is
    #: almost all illegal bytes, so at ``ILLEGAL_OPCODE_COST`` per cycle (now
    #: unrefunded) this budget buys it only the handful of cycles it needs to
    #: prove it can sustain itself before it burns out.
    probe_initial_energy: float = 30.0

    @property
    def size(self) -> int:
        return self.width * self.height


@dataclass
class StepStats:
    """Aggregate counters for a single global clock cycle, consumed by the
    headless benchmark reporter and by analytics/metrics.py.
    """

    cycle: int
    instructions_executed: int = 0
    illegal_opcodes: int = 0
    replications: int = 0
    deaths: int = 0
    jumps: int = 0

    def record(self, result: ExecutionResult) -> None:
        self.instructions_executed += 1
        if result.illegal:
            self.illegal_opcodes += 1
        if result.replicated:
            self.replications += 1
        if result.died:
            self.deaths += 1
        if result.jumped:
            self.jumps += 1


class Environment:
    """The physical world: memory lattice, resource field, and thread registry."""

    def __init__(
        self,
        config: Optional[EnvironmentConfig] = None,
        on_birth: Optional[Callable[[Thread, Optional[Thread]], None]] = None,
        on_death: Optional[Callable[[Thread], None]] = None,
        on_overwrite: Optional[Callable[[Thread, Thread], None]] = None,
        rng: Optional[np.random.Generator] = None,
    ) -> None:
        self.config = config or EnvironmentConfig()
        size = self.config.size
        self.memory: np.ndarray = np.zeros(size, dtype=np.uint8)
        self.owner: np.ndarray = np.full(size, -1, dtype=np.int32)
        self.lineage: np.ndarray = np.full(size, -1, dtype=np.int32)
        self.strain: np.ndarray = np.zeros(size, dtype=np.uint8)
        self.resource: np.ndarray = np.full(size, self.config.baseline_resource, dtype=np.float32)

        self.threads: Dict[int, Thread] = {}
        self.cpu = CPUCore()
        self._lock = threading.Lock()
        self.next_thread_id = 1
        self.next_lineage_id = 1
        self.cycle = 0
        self.on_birth = on_birth
        self.on_death = on_death
        self.on_overwrite = on_overwrite
        self.rng = rng or np.random.default_rng()

        #: coordinates that flashed an instruction-pointer execution this
        #: cycle, for the dashboard's phosphor-burn decay layer to consume.
        self.last_executed_addresses: List[int] = []

        #: the smallest genome length for which the exhaustive scan in
        #: :meth:`request_allocation` has most recently confirmed "no
        #: contiguous free run exists anywhere in the universe" — or
        #: ``None`` if no such confirmation is currently on file. Since any
        #: free run long enough for length ``L`` is also long enough for
        #: every length below ``L``, "no room for L" implies "no room for
        #: anything >= L" too, so this lets later calls requesting a length
        #: at or above the cached value skip straight to failure instead of
        #: re-running the (expensive, at scale) local/windowed/exhaustive
        #: search tiers to rediscover the same answer. Cleared by
        #: :meth:`_reclaim` the moment any memory is freed, since a freed
        #: cell can only make new free runs longer, never shorter.
        self._no_room_for_length: Optional[int] = None

        #: running count of cells currently claimed by some thread's genome
        #: or offspring buffer (``owner != -1``). Kept as an O(1) counter,
        #: incremented/decremented at every claim/release site, since the
        #: occupancy-ceiling check in :meth:`request_allocation` runs on
        #: every ALLOC call — millions of times per benchmark window — and
        #: an ``(self.owner != -1).sum()`` rescan at that frequency would be
        #: far too expensive.
        self._occupied_cells: int = 0

    # ------------------------------------------------------------------
    # Substrate protocol implementation (see core.vm.Substrate)
    # ------------------------------------------------------------------

    def read_byte(self, address: int) -> int:
        return int(self.memory[address % self.memory.size])

    def write_byte(self, address: int, value: int, thread: Thread) -> bool:
        idx = address % self.memory.size
        displaced: Optional[Thread] = None
        with self._lock:
            resident_id = int(self.owner[idx])
            is_foreign_claim = resident_id not in (-1, thread.thread_id)
            resident = self.threads.get(resident_id) if is_foreign_claim else None
            if is_foreign_claim and resident is not None and resident.alive and resident.energy >= thread.energy:
                return False  # higher-or-equal-energy claimant wins; write rejected
            stored_value = value & 0xFF
            if self.rng.random() < self.config.mutation_rate:
                stored_value = int(self.rng.integers(0, 256))
            self.memory[idx] = stored_value
            if is_foreign_claim:
                self.owner[idx] = thread.thread_id
                displaced = resident
        if displaced is not None and self.on_overwrite is not None:
            self.on_overwrite(thread, displaced)
        return True

    def request_allocation(self, thread: Thread) -> Optional[int]:
        length = thread.genome_length
        size = self.memory.size
        with self._lock:
            if self._no_room_for_length is not None and length >= self._no_room_for_length:
                # A previous exhaustive scan already established that no
                # free run this long (or longer) exists anywhere, and
                # nothing has been freed since. Re-running any search tier
                # — even the cheap adjacent-slot check — can only rediscover
                # the same "no" once more, so skip straight to failure.
                return None
            if self._occupied_cells / size >= self.config.max_occupancy_fraction:
                # Refuse to grow any denser than the configured ceiling,
                # even though free space technically still exists: past
                # this density, remaining free cells are fragmented into
                # runs shorter than a genome almost everywhere, which is
                # the gridlock that precedes a mutation-driven death
                # cascade (see max_occupancy_fraction's docstring).
                return None
            for candidate_start in (
                (thread.genome_start + thread.genome_length) % size,  # immediately to the right
                (thread.genome_start - length) % size,  # immediately to the left
            ):
                indices = self.range_indices(candidate_start, length)
                if np.all(self.owner[indices] == -1):
                    self.owner[indices] = thread.thread_id
                    self._occupied_cells += length
                    return candidate_start
            # Neither immediately-adjacent slot is free. Before giving up on
            # locality entirely, search a bounded neighborhood around the
            # parent's own genome for the *nearest* free slot — this is what
            # lets a colony keep expanding outward generation after
            # generation instead of every later offspring being flung to a
            # uniformly random point in the universe the moment its parent's
            # two immediate neighbors fill up.
            span = length * self.config.local_search_radius
            if span > 0:
                local_size = min(2 * span + length, size)
                window_start = (thread.genome_start - span) % size
                local_indices = self.range_indices(window_start, local_size)
                free_local = (self.owner[local_indices] == -1).astype(np.int64)
                window_sum = np.convolve(free_local, np.ones(length, dtype=np.int64), mode="valid")
                valid_offsets = np.flatnonzero(window_sum == length)
                if valid_offsets.size > 0:
                    distances = np.abs(valid_offsets - span)
                    best_offset = int(valid_offsets[np.argmin(distances)])
                    candidate_start = (window_start + best_offset) % size
                    indices = self.range_indices(candidate_start, length)
                    self.owner[indices] = thread.thread_id
                    self._occupied_cells += length
                    return candidate_start
            # No room nearby either. Before paying for a full O(universe)
            # exhaustive scan, try a handful of randomly-positioned windows
            # (the same sliding-window-sum technique as the local search
            # above, just centered at a uniformly random point instead of
            # the parent) — each one checks every offset within it at once,
            # so it finds a free run almost as reliably as the exhaustive
            # scan whenever meaningful free space exists anywhere, at a
            # fraction of the cost. This matters a lot at scale: once
            # colonies saturate their own neighborhoods, this fallback is
            # reached on a large fraction of every ALLOC call as population
            # grows, and an exhaustive rescan on every one of those misses
            # became the dominant cost of the entire simulation — far more
            # than the per-cycle CPU-execution loop itself — once population
            # climbed into the thousands. (A pointwise random-start probe
            # was tried first and rejected: free space exists in scattered
            # genome-length-sized runs, so the odds of a single random byte
            # landing exactly on a run's start are far lower than the odds
            # of *some* offset within a random window matching one.)
            kernel = np.ones(length, dtype=np.int64)
            for _ in range(GLOBAL_ALLOCATION_PROBE_WINDOWS):
                window_start = int(self.rng.integers(0, size))
                window_size = min(GLOBAL_ALLOCATION_PROBE_WINDOW_SIZE, size)
                probe_indices = self.range_indices(window_start, window_size)
                free_probe = (self.owner[probe_indices] == -1).astype(np.int64)
                window_sum = np.convolve(free_probe, kernel, mode="valid")
                valid_offsets = np.flatnonzero(window_sum == length)
                if valid_offsets.size > 0:
                    best_offset = int(valid_offsets[0])
                    candidate_start = (window_start + best_offset) % size
                    indices = self.range_indices(candidate_start, length)
                    self.owner[indices] = thread.thread_id
                    self._occupied_cells += length
                    return candidate_start
            # Every random window missed — exhaustively (but cheaply, via a
            # vectorized sliding-window sum) find every toroidal starting
            # position whose next `length` cells are all free, and pick one
            # at random. This is deterministic in the sense that it only
            # returns None when the universe is genuinely full, never due to
            # an unlucky random probe.
            free = (self.owner == -1).astype(np.int64)
            extended = np.concatenate([free, free[: length - 1]]) if length > 1 else free
            window_sum = np.convolve(extended, np.ones(length, dtype=np.int64), mode="valid")[:size]
            candidates = np.flatnonzero(window_sum == length)
            if candidates.size == 0:
                if self._no_room_for_length is None or length < self._no_room_for_length:
                    self._no_room_for_length = length
                return None
            candidate_start = int(self.rng.choice(candidates))
            indices = self.range_indices(candidate_start, length)
            self.owner[indices] = thread.thread_id
            self._occupied_cells += length
            return candidate_start

    def harvest_energy(self, address: int, amount: float) -> float:
        idx = address % self.resource.size
        if amount >= 0:
            available = float(self.resource[idx])
            drawn = min(available, amount)
            self.resource[idx] -= drawn
            return drawn
        deposit = -amount
        before = float(self.resource[idx])
        self.resource[idx] = min(self.config.max_resource, before + deposit)
        # Report how much actually landed: a cell already at max_resource
        # absorbs less than requested (or nothing), and callers depositing
        # energy they would otherwise lose can use this to avoid silently
        # destroying the overflow.
        return float(self.resource[idx]) - before

    def sense_resource(self, address: int) -> int:
        idx = address % self.resource.size
        if self.config.max_resource <= 0:
            return 0
        density = float(self.resource[idx]) / self.config.max_resource
        return int(np.clip(density, 0.0, 1.0) * 255)

    def finalize_offspring(self, parent: Thread) -> None:
        if parent.offspring_start is None:
            raise EnergyExhaustionError(parent.thread_id, parent.energy)
        child_energy = parent.energy * self.config.offspring_energy_share
        parent.energy -= child_energy
        with self._lock:
            child_id = self.next_thread_id
            self.next_thread_id += 1
            child = Thread(
                thread_id=child_id,
                genome_start=parent.offspring_start,
                genome_length=parent.offspring_length,
                energy=child_energy,
                generation=parent.generation + 1,
                lineage_id=parent.lineage_id,
                parent_id=parent.thread_id,
                strain=parent.strain,
            )
            self.threads[child_id] = child
            indices = self.range_indices(child.genome_start, child.genome_length)
            # These cells were already counted in self._occupied_cells when
            # request_allocation reserved them for the parent's offspring
            # buffer; this only re-labels ownership to the new child, so no
            # further increment is needed here.
            self.owner[indices] = child_id
            self.lineage[indices] = child.lineage_id
            self.strain[indices] = _STRAIN_NAME_TO_CODE.get(child.strain, STRAIN_NONE)
        # on_birth is invoked outside the lock: it runs the tracer's own
        # (separately-locked) bookkeeping and must never nest the two locks.
        if self.on_birth is not None:
            self.on_birth(child, parent)

    # ------------------------------------------------------------------
    # Organism lifecycle helpers used by core.initializer
    # ------------------------------------------------------------------

    def spawn_organism(self, genome: bytes, address: int, strain: str, lineage_id: Optional[int] = None) -> Thread:
        """Write ``genome`` into memory starting at ``address`` and register
        a live :class:`Thread` to execute it. Used by the initializer to
        plant ancestor copies, and by :meth:`_spawn_probe_threads` to open
        exploratory CPU contexts over raw noise.
        """
        if self.config.initial_energy <= EXHAUSTION_THRESHOLD:
            raise EnergyExhaustionError(-1, self.config.initial_energy)
        length = len(genome)
        indices = self.range_indices(address, length)
        with self._lock:
            self.memory[indices] = np.frombuffer(genome, dtype=np.uint8)
            resolved_lineage = lineage_id if lineage_id is not None else self.next_lineage_id
            if lineage_id is None:
                self.next_lineage_id += 1
            self.owner[indices] = self.next_thread_id
            self.lineage[indices] = resolved_lineage
            self.strain[indices] = _STRAIN_NAME_TO_CODE.get(strain, STRAIN_NONE)
            self._occupied_cells += length
            thread = Thread(
                thread_id=self.next_thread_id,
                genome_start=address % self.memory.size,
                genome_length=length,
                energy=self.config.initial_energy,
                lineage_id=resolved_lineage,
                strain=strain,
            )
            self.threads[thread.thread_id] = thread
            self.next_thread_id += 1
        if self.on_birth is not None:
            self.on_birth(thread, None)
        return thread

    # ------------------------------------------------------------------
    # Per-cycle orchestration
    # ------------------------------------------------------------------

    def step(self) -> StepStats:
        """Advance the entire universe by exactly one global clock cycle:
        diffuse resources, open noise probes, then give every living thread
        exactly one instruction of execution (round-robin scheduling).
        """
        self.cycle += 1
        self._diffuse_resources()
        self._spawn_probe_threads()

        stats = StepStats(cycle=self.cycle)
        self.last_executed_addresses = []
        for thread_id in list(self.threads.keys()):
            thread = self.threads.get(thread_id)
            if thread is None or not thread.alive:
                continue
            address = thread.absolute_ip()
            self.last_executed_addresses.append(address)
            result = self.cpu.execute(thread, self)
            if result.tasks_completed:
                self._award_task_bonus(address, len(result.tasks_completed))
            if not result.died and self.config.senescence_rate > 0.0:
                thread.energy -= self.config.senescence_rate
                if thread.energy <= EXHAUSTION_THRESHOLD:
                    thread.alive = False
                    result.died = True
                    result.note = "senescence exhausted thread"
            stats.record(result)
            if result.died:
                self._reclaim(thread)
        return stats

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _award_task_bonus(self, address: int, task_count: int) -> None:
        """Pay out :data:`EnvironmentConfig.task_bonus_energy` once per
        newly-completed task, via the same negative-``harvest_energy``
        deposit convention :meth:`CPUCore.execute`'s SHARE handling already
        uses: the bonus lands in the resource field at the rewarded
        thread's own current address rather than being credited to its
        energy balance directly, so it stays inside the substrate's single
        thermodynamic-field model instead of becoming a second, parallel
        currency. The thread (or any neighbor) then harvests it the
        ordinary way on a subsequent instruction.
        """
        bonus = self.config.task_bonus_energy * task_count
        if bonus <= 0.0:
            return
        self.harvest_energy(address, -bonus)

    def range_indices(self, start: int, length: int) -> np.ndarray:
        size = self.memory.size
        return (np.arange(start, start + length) % size).astype(np.int64)

    def _diffuse_resources(self) -> None:
        grid = self.resource.reshape(self.config.height, self.config.width)
        neighbor_avg = (
            np.roll(grid, 1, axis=0)
            + np.roll(grid, -1, axis=0)
            + np.roll(grid, 1, axis=1)
            + np.roll(grid, -1, axis=1)
        ) / 4.0
        rate = self.config.diffusion_rate
        blended = grid * (1.0 - rate) + neighbor_avg * rate
        regen = (self.config.baseline_resource - blended) * self.config.regen_rate
        np.clip(blended + regen, 0.0, self.config.max_resource, out=grid)

    def _spawn_probe_threads(self) -> None:
        """Open a handful of exploratory CPU contexts over unclaimed memory
        each cycle, modeling the thermal/quantum noise that real chemistry
        relies on to occasionally try interpreting an arbitrary sequence.
        Almost every probe will hit an illegal opcode within a cycle or two
        and die — that rarity is the point, not a bug.
        """
        length = self.config.probe_genome_length
        size = self.memory.size
        for _ in range(self.config.probe_spawn_count):
            start = int(self.rng.integers(0, size))
            indices = self.range_indices(start, length)
            if not np.all(self.owner[indices] == -1):
                continue
            genome = bytes(self.memory[indices])
            with self._lock:
                lineage_id = self.next_lineage_id
                self.next_lineage_id += 1
                self.owner[indices] = self.next_thread_id
                self.lineage[indices] = lineage_id
                self.strain[indices] = STRAIN_NOISE
                self._occupied_cells += length
                thread = Thread(
                    thread_id=self.next_thread_id,
                    genome_start=start,
                    genome_length=length,
                    energy=self.config.probe_initial_energy,
                    lineage_id=lineage_id,
                    strain="noise",
                )
                self.threads[thread.thread_id] = thread
                self.next_thread_id += 1
            if self.on_birth is not None:
                self.on_birth(thread, None)

    def _free_region(self, start: int, length: int, owner_id: Optional[int] = None) -> None:
        """Reset a contiguous toroidal region back to unclaimed background
        noise. Must be called with ``self._lock`` already held.

        If ``owner_id`` is given, only cells *currently* owned by that thread
        are cleared and the rest are left untouched — a higher-energy foreign
        writer may have legitimately stolen part of the region while the
        owner was still alive, and those cells are not ours to reclaim.
        """
        indices = self.range_indices(start, length)
        if owner_id is not None:
            indices = indices[self.owner[indices] == owner_id]
            if indices.size == 0:
                return
        self.memory[indices] = self.rng.integers(0, 256, size=indices.size, dtype=np.uint8)
        self.owner[indices] = -1
        self.lineage[indices] = -1
        self.strain[indices] = STRAIN_NONE
        self._occupied_cells -= int(indices.size)

    def _reclaim(self, thread: Thread) -> None:
        """Return a dead organism's memory — and any unfinished offspring
        cradle it had already claimed — to raw background noise.

        A thread that dies mid-replication still owns the offspring buffer it
        reserved back at ``ALLOC`` time (see :meth:`request_allocation`,
        which stamps ``owner`` immediately, long before the copy finishes).
        Releasing only the parent's own genome here, as earlier versions did,
        left that buffer claimed by a thread that no longer exists —
        permanently removing those cells from the allocatable pool. Under
        steady energy pressure, organisms die mid-copy constantly, so the
        leak compounds cycle after cycle and silently strangles the
        universe's effective carrying capacity. Free both regions.
        """
        if self.on_death is not None:
            self.on_death(thread)
        with self._lock:
            self._free_region(thread.genome_start, thread.genome_length)
            if thread.offspring_start is not None and thread.offspring_length:
                self._free_region(
                    thread.offspring_start, thread.offspring_length, owner_id=thread.thread_id
                )
            self.threads.pop(thread.thread_id, None)
            # Freeing memory can only lengthen (or create) free runs, never
            # shorten them, so any previously-confirmed "no room" verdict is
            # no longer trustworthy and must be re-earned by the next scan.
            self._no_room_for_length = None

    # ------------------------------------------------------------------
    # Read-only views for analytics / visualization
    # ------------------------------------------------------------------

    def living_threads(self) -> List[Thread]:
        # Snapshot under the lock: in dashboard / dashboard-server modes the
        # simulation thread mutates self.threads while this reader thread
        # iterates, which would otherwise risk "dictionary changed size
        # during iteration".
        with self._lock:
            return [t for t in self.threads.values() if t.alive]

    def population_by_strain(self) -> Dict[str, int]:
        counts = {"seed": 0, "noise": 0}
        with self._lock:
            threads = list(self.threads.values())
        for t in threads:
            if t.alive:
                counts[t.strain] = counts.get(t.strain, 0) + 1
        return counts
