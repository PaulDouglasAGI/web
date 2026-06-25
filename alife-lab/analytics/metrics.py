"""analytics/metrics.py — Phylogenetic Tracing & Information Theory.

Real-time mathematical analysis of the live memory pool: the absolute
Shannon entropy of the global lattice (a direct measure of how much order
digital life has imposed on what started as uniform noise), an automated
phylogenetic tracer that builds the ancestry tree as organisms are born
and die, and an approximate Kolmogorov complexity score for the genomes of
the currently-dominant strains.

This module only ever *observes* the :class:`~core.environment.Environment`
through its public hooks (``on_birth``/``on_death``/``on_overwrite``) and
public ``range_indices`` helper — it never touches CPU execution. The one
exception is :class:`PhylogeneticTracer`'s speciation detection, which does
reassign a divergent child's ``lineage_id`` and the corresponding
``Environment.lineage`` cells: lineage id is pure bookkeeping (it has no
effect on CPU semantics, energy, or replication), so retagging it here, at
the point genomic divergence is actually measured, is the natural place
for that to happen rather than duplicating divergence math inside the
environment's hot loop.
"""

from __future__ import annotations

import threading
import zlib
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, List, Optional, Set, Tuple

import numpy as np

#: Upper bound on how many individual SpeciationEvent / OverwriteEvent records
#: the tracer retains for inspection. The aggregate counts that drive the
#: metrics readout are kept as O(1) running totals (see PhylogeneticTracer),
#: so this only caps the rolling *detail* history — without it, a long run
#: (e.g. a million cycles) would accumulate these event objects without limit
#: and grow the process's memory unboundedly.
MAX_RETAINED_EVENTS = 50_000

from core.environment import Environment
from core.vm import Thread


def shannon_entropy(memory: np.ndarray) -> float:
    """Absolute Shannon entropy, in bits per byte, of a byte array.

    A freshly-randomized lattice sits at (or very near) 8.0 bits/byte —
    maximum disorder. As self-replicators copy themselves across large
    stretches of memory, the byte-value distribution skews toward whatever
    bytes their genome is built from, and entropy falls measurably below
    8.0: a direct, literal measurement of digital life imposing order on
    chaos.
    """
    if memory.size == 0:
        return 0.0
    counts = np.bincount(memory.reshape(-1), minlength=256).astype(np.float64)
    probabilities = counts[counts > 0] / memory.size
    return float(-np.sum(probabilities * np.log2(probabilities)))


def kolmogorov_complexity_approx(genome: bytes) -> int:
    """Approximate Kolmogorov complexity via DEFLATE-compressed length.

    True Kolmogorov complexity is uncomputable; compressed length is the
    standard practical proxy — a short, repetitive, highly-ordered genome
    (e.g. a minimal self-replicator with long NOP/INC padding runs)
    compresses far smaller than an equal-length stretch of true noise.
    """
    if not genome:
        return 0
    return len(zlib.compress(bytes(genome), level=9))


@dataclass
class LineageRecord:
    """One node in the phylogenetic tree: a single lineage's vital statistics."""

    lineage_id: int
    parent_lineage_id: Optional[int]
    origin_strain: str
    birth_cycle: int
    founder_thread_id: int
    total_births: int = 0
    total_deaths: int = 0
    alive_count: int = 0


@dataclass
class SpeciationEvent:
    """A child whose genome diverged from its parent's by enough to be
    considered a new species rather than a clone."""

    cycle: int
    parent_lineage_id: int
    child_lineage_id: int
    hamming_distance: int
    genome_length: int

    @property
    def divergence_fraction(self) -> float:
        return self.hamming_distance / self.genome_length if self.genome_length else 0.0


@dataclass
class OverwriteEvent:
    """One thread's write displaced another thread's resident claim."""

    cycle: int
    winner_lineage_id: int
    loser_lineage_id: int
    winner_strain: str
    loser_strain: str


@dataclass
class MetricsSnapshot:
    """The complete real-time readout for a single cycle, consumed by the
    headless benchmark reporter (``main.py``) and the dashboard's
    right-hand data panel (``viz/dashboard.py``).
    """

    cycle: int
    shannon_entropy: float
    active_threads: int
    population_by_strain: Dict[str, int]
    total_births: int
    total_deaths: int
    speciation_count: int
    noise_defeats_seed: int
    seed_defeats_noise: int
    dominant_lineages: List[Tuple[int, int]]


class PhylogeneticTracer:
    """Wires onto an :class:`Environment`'s lifecycle hooks to build a live
    ancestry tree, flag speciation events by genomic Hamming distance, and
    tally cross-strain takeover events (noise overwriting seed and vice
    versa).
    """

    def __init__(self, divergence_threshold: float = 0.15) -> None:
        """``divergence_threshold`` is the fraction of genome bytes that
        must differ between parent and child for the child to be tagged as
        a new lineage rather than inheriting its parent's.
        """
        self.divergence_threshold = divergence_threshold
        self.lineages: Dict[int, LineageRecord] = {}
        #: Bounded rolling detail history (see MAX_RETAINED_EVENTS); the
        #: aggregate counts below are the source of truth for the readout.
        self.speciation_events: Deque[SpeciationEvent] = deque(maxlen=MAX_RETAINED_EVENTS)
        self.overwrite_events: Deque[OverwriteEvent] = deque(maxlen=MAX_RETAINED_EVENTS)
        self._cycle = 0

        #: O(1) running totals — incremented in the hooks rather than
        #: recomputed by scanning every lineage / every event on each
        #: snapshot, so a periodic report stays cheap no matter how long the
        #: run or how much history has accrued.
        self._total_births = 0
        self._total_deaths = 0
        self._speciation_count = 0
        self._noise_defeats_seed = 0
        self._seed_defeats_noise = 0
        #: ids of lineages with at least one living member, so dominant_lineages
        #: only ever sorts the currently-alive lineages instead of every
        #: lineage that has ever existed.
        self._live_lineage_ids: Set[int] = set()

        #: Guards all tracer state. The simulation thread mutates it through
        #: the lifecycle hooks while the dashboard / HTTP-stats thread reads it
        #: through the query methods (see viz/server.py, viz/dashboard.py);
        #: the hooks are always invoked outside Environment._lock, so this
        #: never nests with it.
        self._lock = threading.Lock()

    def set_cycle(self, cycle: int) -> None:
        self._cycle = cycle

    def on_birth(self, child: Thread, parent: Optional[Thread], environment: Environment) -> None:
        with self._lock:
            if parent is not None:
                self._maybe_speciate(child, parent, environment)
            if child.lineage_id not in self.lineages:
                self.lineages[child.lineage_id] = LineageRecord(
                    lineage_id=child.lineage_id,
                    parent_lineage_id=parent.lineage_id if parent is not None else None,
                    origin_strain=child.strain,
                    birth_cycle=self._cycle,
                    founder_thread_id=child.thread_id,
                )
            record = self.lineages[child.lineage_id]
            record.total_births += 1
            record.alive_count += 1
            self._total_births += 1
            if record.alive_count > 0:
                self._live_lineage_ids.add(record.lineage_id)

    def on_death(self, thread: Thread) -> None:
        with self._lock:
            record = self.lineages.get(thread.lineage_id)
            if record is not None:
                record.total_deaths += 1
                record.alive_count = max(0, record.alive_count - 1)
                self._total_deaths += 1
                if record.alive_count == 0:
                    self._live_lineage_ids.discard(record.lineage_id)

    def on_overwrite(self, winner: Thread, loser: Thread) -> None:
        with self._lock:
            if winner.strain == "noise" and loser.strain == "seed":
                self._noise_defeats_seed += 1
            elif winner.strain == "seed" and loser.strain == "noise":
                self._seed_defeats_noise += 1
            self.overwrite_events.append(
                OverwriteEvent(
                    cycle=self._cycle,
                    winner_lineage_id=winner.lineage_id,
                    loser_lineage_id=loser.lineage_id,
                    winner_strain=winner.strain,
                    loser_strain=loser.strain,
                )
            )

    def dominant_lineages(self, top_n: int = 5) -> List[Tuple[int, int]]:
        """The ``top_n`` lineages by current living population, as
        ``(lineage_id, alive_count)`` pairs, highest first."""
        with self._lock:
            live = (self.lineages[lid] for lid in self._live_lineage_ids if lid in self.lineages)
            ranked = sorted(live, key=lambda r: r.alive_count, reverse=True)
            return [(r.lineage_id, r.alive_count) for r in ranked[:top_n] if r.alive_count > 0]

    @property
    def speciation_count(self) -> int:
        return self._speciation_count

    def noise_defeats_seed_count(self) -> int:
        return self._noise_defeats_seed

    def seed_defeats_noise_count(self) -> int:
        return self._seed_defeats_noise

    def total_births(self) -> int:
        return self._total_births

    def total_deaths(self) -> int:
        return self._total_deaths

    def _maybe_speciate(self, child: Thread, parent: Thread, environment: Environment) -> None:
        length = child.genome_length
        if length != parent.genome_length:
            distance = max(length, parent.genome_length)
        else:
            child_genes = environment.memory[environment.range_indices(child.genome_start, length)]
            parent_genes = environment.memory[environment.range_indices(parent.genome_start, length)]
            distance = int(np.count_nonzero(child_genes != parent_genes))

        if length and (distance / length) >= self.divergence_threshold:
            new_lineage_id = environment.next_lineage_id
            environment.next_lineage_id += 1
            indices = environment.range_indices(child.genome_start, length)
            environment.lineage[indices] = new_lineage_id
            child.lineage_id = new_lineage_id
            self._speciation_count += 1
            self.speciation_events.append(
                SpeciationEvent(
                    cycle=self._cycle,
                    parent_lineage_id=parent.lineage_id,
                    child_lineage_id=new_lineage_id,
                    hamming_distance=distance,
                    genome_length=length,
                )
            )


def dominant_strain_complexity(
    environment: Environment, tracer: PhylogeneticTracer, top_n: int = 3
) -> Dict[int, int]:
    """Approximate Kolmogorov complexity of one representative living
    genome from each of the ``top_n`` most populous current lineages.
    """
    complexities: Dict[int, int] = {}
    # Snapshot the thread set once under the environment lock so the
    # simulation thread can't mutate it mid-iteration (dashboard modes).
    living = environment.living_threads()
    for lineage_id, _count in tracer.dominant_lineages(top_n=top_n):
        representative = next(
            (t for t in living if t.lineage_id == lineage_id), None
        )
        if representative is None:
            continue
        indices = environment.range_indices(representative.genome_start, representative.genome_length)
        genome = bytes(environment.memory[indices])
        complexities[lineage_id] = kolmogorov_complexity_approx(genome)
    return complexities


def take_snapshot(environment: Environment, tracer: PhylogeneticTracer) -> MetricsSnapshot:
    """Compute the full real-time metrics readout for the environment's
    current cycle."""
    return MetricsSnapshot(
        cycle=environment.cycle,
        shannon_entropy=shannon_entropy(environment.memory),
        active_threads=len(environment.living_threads()),
        population_by_strain=environment.population_by_strain(),
        total_births=tracer.total_births(),
        total_deaths=tracer.total_deaths(),
        speciation_count=tracer.speciation_count,
        noise_defeats_seed=tracer.noise_defeats_seed_count(),
        seed_defeats_noise=tracer.seed_defeats_noise_count(),
        dominant_lineages=tracer.dominant_lineages(),
    )
