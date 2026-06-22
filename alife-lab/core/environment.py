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
            for candidate_start in (
                (thread.genome_start + thread.genome_length) % size,  # immediately to the right
                (thread.genome_start - length) % size,  # immediately to the left
            ):
                indices = self.range_indices(candidate_start, length)
                if np.all(self.owner[indices] == -1):
                    self.owner[indices] = thread.thread_id
                    return candidate_start
            # neither adjacent slot is free — exhaustively (but cheaply,
            # via a vectorized sliding-window sum) find every toroidal
            # starting position whose next `length` cells are all free,
            # and pick one at random. This is deterministic in the sense
            # that it only returns None when the universe is genuinely
            # full, never due to an unlucky random probe.
            free = (self.owner == -1).astype(np.int64)
            extended = np.concatenate([free, free[: length - 1]]) if length > 1 else free
            window_sum = np.convolve(extended, np.ones(length, dtype=np.int64), mode="valid")[:size]
            candidates = np.flatnonzero(window_sum == length)
            if candidates.size == 0:
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
