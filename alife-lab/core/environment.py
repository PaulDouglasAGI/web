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
            for candidate_start in (
                (thread.genome_start + thread.genome_length) % size,  # immediately to the right
                (thread.genome_start - length) % size,  # immediately to the left
            ):
                indices = self.range_indices(candidate_start, length)
                if np.all(self.owner[indices] == -1):
                    self.owner[indices] = thread.thread_id
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
            return candidate_start

    def harvest_energy(self, address: int, amount: float) -> float:
        idx = address % self.resource.size
        if amount >= 0:
            available = float(self.resource[idx])
            drawn = min(available, amount)
            self.resource[idx] -= drawn
            return drawn
        deposit = -amount
        self.resource[idx] = min(self.config.max_resource, float(self.resource[idx]) + deposit)
        return 0.0

    def finalize_offspring(self, parent: Thread) -> None:
        if parent.offspring_start is None:
            raise EnergyExhaustionError(parent.thread_id, parent.energy)
        child_id = self.next_thread_id
        self.next_thread_id += 1
        child_energy = parent.energy * self.config.offspring_energy_share
        parent.energy -= child_energy
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
        self.owner[indices] = child_id
        self.lineage[indices] = child.lineage_id
        self.strain[indices] = _STRAIN_NAME_TO_CODE.get(child.strain, STRAIN_NONE)
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
            self.last_executed_addresses.append(thread.absolute_ip())
            result = self.cpu.execute(thread, self)
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
                thread = Thread(
                    thread_id=self.next_thread_id,
                    genome_start=start,
                    genome_length=length,
                    energy=self.config.baseline_resource * length * 0.5,
                    lineage_id=lineage_id,
                    strain="noise",
                )
                self.threads[thread.thread_id] = thread
                self.next_thread_id += 1
            if self.on_birth is not None:
                self.on_birth(thread, None)

    def _reclaim(self, thread: Thread) -> None:
        """Return a dead organism's memory to raw background noise."""
        if self.on_death is not None:
            self.on_death(thread)
        indices = self.range_indices(thread.genome_start, thread.genome_length)
        with self._lock:
            self.memory[indices] = self.rng.integers(0, 256, size=indices.size, dtype=np.uint8)
            self.owner[indices] = -1
            self.lineage[indices] = -1
            self.strain[indices] = STRAIN_NONE
            self.threads.pop(thread.thread_id, None)
            # Freeing memory can only lengthen (or create) free runs, never
            # shorten them, so any previously-confirmed "no room" verdict is
            # no longer trustworthy and must be re-earned by the next scan.
            self._no_room_for_length = None

    # ------------------------------------------------------------------
    # Read-only views for analytics / visualization
    # ------------------------------------------------------------------

    def living_threads(self) -> List[Thread]:
        return [t for t in self.threads.values() if t.alive]

    def population_by_strain(self) -> Dict[str, int]:
        counts = {"seed": 0, "noise": 0}
        for t in self.threads.values():
            if t.alive:
                counts[t.strain] = counts.get(t.strain, 0) + 1
        return counts
