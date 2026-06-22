"""Phase-3 verification tests for analytics/metrics.py."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.environment import Environment, EnvironmentConfig  # noqa: E402
from core.vm import Opcode, Thread  # noqa: E402
from analytics.metrics import (  # noqa: E402
    MetricsSnapshot,
    PhylogeneticTracer,
    dominant_strain_complexity,
    kolmogorov_complexity_approx,
    shannon_entropy,
    take_snapshot,
)


def test_shannon_entropy_of_uniform_byte_array_is_zero() -> None:
    memory = np.full(1000, 7, dtype=np.uint8)
    assert shannon_entropy(memory) == pytest.approx(0.0, abs=1e-9)


def test_shannon_entropy_of_perfectly_flat_distribution_is_eight_bits() -> None:
    memory = np.tile(np.arange(256, dtype=np.uint8), 50)  # every byte value equally often
    assert shannon_entropy(memory) == pytest.approx(8.0, abs=1e-6)


def test_shannon_entropy_of_empty_array_is_zero() -> None:
    assert shannon_entropy(np.array([], dtype=np.uint8)) == 0.0


def test_kolmogorov_complexity_of_repetitive_genome_is_smaller_than_random() -> None:
    rng = np.random.default_rng(3)
    repetitive = bytes([Opcode.NOP, Opcode.INC] * 100)
    random_bytes = bytes(rng.integers(0, 256, size=200, dtype=np.uint8))
    assert kolmogorov_complexity_approx(repetitive) < kolmogorov_complexity_approx(random_bytes)


def test_kolmogorov_complexity_of_empty_genome_is_zero() -> None:
    assert kolmogorov_complexity_approx(b"") == 0


def make_env() -> Environment:
    config = EnvironmentConfig(width=8, height=8, probe_spawn_count=0, mutation_rate=0.0)
    return Environment(config=config, rng=np.random.default_rng(11))


def test_on_birth_without_parent_founds_a_new_lineage() -> None:
    tracer = PhylogeneticTracer()
    env = make_env()
    founder = Thread(thread_id=1, genome_start=0, genome_length=4, lineage_id=1, strain="seed")
    tracer.on_birth(founder, None, env)
    record = tracer.lineages[1]
    assert record.parent_lineage_id is None
    assert record.origin_strain == "seed"
    assert record.total_births == 1
    assert record.alive_count == 1


def test_clone_offspring_inherits_parent_lineage_without_speciation() -> None:
    tracer = PhylogeneticTracer(divergence_threshold=0.15)
    env = make_env()
    env.memory[0:4] = [Opcode.ALLOC, Opcode.NOP, Opcode.READ_HEAD, Opcode.WRITE_HEAD]
    env.memory[20:24] = [Opcode.ALLOC, Opcode.NOP, Opcode.READ_HEAD, Opcode.WRITE_HEAD]  # identical copy

    parent = Thread(thread_id=1, genome_start=0, genome_length=4, lineage_id=5, strain="seed")
    child = Thread(thread_id=2, genome_start=20, genome_length=4, lineage_id=5, strain="seed", parent_id=1)

    tracer.on_birth(parent, None, env)
    tracer.on_birth(child, parent, env)

    assert child.lineage_id == 5  # unchanged: clone, not a new species
    assert len(tracer.speciation_events) == 0
    assert tracer.lineages[5].alive_count == 2


def test_divergent_offspring_forks_a_new_lineage() -> None:
    tracer = PhylogeneticTracer(divergence_threshold=0.15)
    env = make_env()
    env.memory[0:4] = [Opcode.ALLOC, Opcode.NOP, Opcode.READ_HEAD, Opcode.WRITE_HEAD]
    env.memory[20:24] = [Opcode.DEC, Opcode.DEC, Opcode.DEC, Opcode.DEC]  # wildly different

    parent = Thread(thread_id=1, genome_start=0, genome_length=4, lineage_id=5, strain="seed")
    child = Thread(thread_id=2, genome_start=20, genome_length=4, lineage_id=5, strain="seed", parent_id=1)

    tracer.on_birth(parent, None, env)
    next_lineage_before = env.next_lineage_id
    tracer.on_birth(child, parent, env)

    assert child.lineage_id == next_lineage_before  # forked onto a fresh id
    assert child.lineage_id != 5
    assert len(tracer.speciation_events) == 1
    event = tracer.speciation_events[0]
    assert event.parent_lineage_id == 5
    assert event.hamming_distance == 4
    assert np.all(env.lineage[20:24] == child.lineage_id)


def test_on_death_decrements_alive_count_and_records_total_deaths() -> None:
    tracer = PhylogeneticTracer()
    env = make_env()
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, lineage_id=9, strain="noise")
    tracer.on_birth(thread, None, env)
    tracer.on_death(thread)
    record = tracer.lineages[9]
    assert record.alive_count == 0
    assert record.total_deaths == 1


def test_on_death_for_unknown_lineage_is_a_safe_no_op() -> None:
    tracer = PhylogeneticTracer()
    ghost = Thread(thread_id=99, genome_start=0, genome_length=4, lineage_id=12345)
    tracer.on_death(ghost)  # must not raise


def test_overwrite_tallies_cross_strain_takeovers() -> None:
    tracer = PhylogeneticTracer()
    noise_winner = Thread(thread_id=1, genome_start=0, genome_length=4, lineage_id=1, strain="noise")
    seed_loser = Thread(thread_id=2, genome_start=10, genome_length=4, lineage_id=2, strain="seed")
    seed_winner = Thread(thread_id=3, genome_start=20, genome_length=4, lineage_id=3, strain="seed")
    noise_loser = Thread(thread_id=4, genome_start=30, genome_length=4, lineage_id=4, strain="noise")

    tracer.on_overwrite(noise_winner, seed_loser)
    tracer.on_overwrite(seed_winner, noise_loser)
    tracer.on_overwrite(noise_winner, seed_loser)

    assert tracer.noise_defeats_seed_count() == 2
    assert tracer.seed_defeats_noise_count() == 1


def test_dominant_lineages_ranks_by_alive_count_descending() -> None:
    tracer = PhylogeneticTracer()
    env = make_env()
    small = Thread(thread_id=1, genome_start=0, genome_length=1, lineage_id=1, strain="seed")
    big_a = Thread(thread_id=2, genome_start=1, genome_length=1, lineage_id=2, strain="seed")
    big_b = Thread(thread_id=3, genome_start=2, genome_length=1, lineage_id=2, strain="seed")
    tracer.on_birth(small, None, env)
    tracer.on_birth(big_a, None, env)
    tracer.on_birth(big_b, big_a, env)  # same lineage as big_a (clone, identical 1-byte genome)

    ranked = tracer.dominant_lineages(top_n=2)
    assert ranked[0][0] == 2
    assert ranked[0][1] == 2


def test_dominant_strain_complexity_returns_score_per_dominant_lineage() -> None:
    tracer = PhylogeneticTracer()
    env = make_env()
    env.memory[0:4] = [Opcode.NOP, Opcode.NOP, Opcode.NOP, Opcode.NOP]
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, lineage_id=1, strain="seed")
    env.threads[1] = thread
    tracer.on_birth(thread, None, env)

    complexities = dominant_strain_complexity(env, tracer, top_n=3)
    assert 1 in complexities
    assert complexities[1] > 0


def test_take_snapshot_reflects_live_environment_and_tracer_state() -> None:
    env = make_env()
    tracer = PhylogeneticTracer()
    thread = env.spawn_organism(genome=bytes([Opcode.NOP] * 4), address=0, strain="seed")
    tracer.on_birth(thread, None, env)

    snapshot = take_snapshot(env, tracer)
    assert isinstance(snapshot, MetricsSnapshot)
    assert snapshot.active_threads == 1
    assert snapshot.population_by_strain["seed"] == 1
    assert snapshot.total_births == 1
    assert 0.0 <= snapshot.shannon_entropy <= 8.0
