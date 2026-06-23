"""Phase-3 verification tests for core/persistence.py — checkpoint/resume."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.environment import Environment, EnvironmentConfig  # noqa: E402
from core.persistence import load_checkpoint, save_checkpoint  # noqa: E402
from core.vm import Opcode, Thread  # noqa: E402
from main import build_traced_environment, resume_traced_environment, run_headless  # noqa: E402


def make_env(**overrides) -> Environment:
    config = EnvironmentConfig(width=8, height=8, probe_spawn_count=0, mutation_rate=0.0, **overrides)
    return Environment(config=config, rng=np.random.default_rng(42))


def test_round_trip_preserves_arrays_threads_and_rng_state(tmp_path: Path) -> None:
    env = make_env(task_bonus_energy=5.0)
    thread = Thread(
        thread_id=1,
        genome_start=0,
        genome_length=4,
        energy=12.5,
        recent_inputs=[1, 2],
        tasks_completed={"and"},
    )
    env.threads[1] = thread
    env.owner[0:4] = 1
    env.memory[0:4] = Opcode.NOP
    env.cycle = 17
    env.next_thread_id = 2
    env.next_lineage_id = 3
    env.rng.random()  # advance the RNG once, so the saved state isn't the seed's initial state

    checkpoint_path = tmp_path / "checkpoint"
    save_checkpoint(env, _fake_tracer(), str(checkpoint_path))
    restored, tracer = load_checkpoint(str(checkpoint_path))

    assert np.array_equal(restored.memory, env.memory)
    assert np.array_equal(restored.owner, env.owner)
    assert np.array_equal(restored.lineage, env.lineage)
    assert np.array_equal(restored.strain, env.strain)
    assert np.array_equal(restored.resource, env.resource)
    assert restored.cycle == 17
    assert restored.next_thread_id == 2
    assert restored.next_lineage_id == 3
    assert restored.config.task_bonus_energy == pytest.approx(5.0)

    restored_thread = restored.threads[1]
    assert restored_thread.energy == pytest.approx(12.5)
    assert restored_thread.recent_inputs == [1, 2]
    assert restored_thread.tasks_completed == {"and"}

    # the RNG's own bit-generator state round-trips too, so a resumed run
    # produces the exact same sequence of "random" numbers a continuous
    # run would have.
    fresh_env = make_env(task_bonus_energy=5.0)
    fresh_env.rng.random()  # consume the same one draw `env` already took
    assert restored.rng.random() == pytest.approx(fresh_env.rng.random())


def test_checkpoint_preserves_tracer_lineage_and_event_history(tmp_path: Path) -> None:
    env, tracer = make_env(), _fake_tracer()
    checkpoint_path = tmp_path / "checkpoint"
    save_checkpoint(env, tracer, str(checkpoint_path))
    _restored_env, restored_tracer = load_checkpoint(str(checkpoint_path))

    assert restored_tracer.divergence_threshold == pytest.approx(tracer.divergence_threshold)
    assert set(restored_tracer.lineages) == set(tracer.lineages)
    assert len(restored_tracer.speciation_events) == len(tracer.speciation_events)
    assert len(restored_tracer.overwrite_events) == len(tracer.overwrite_events)
    assert restored_tracer.speciation_events[0].hamming_distance == tracer.speciation_events[0].hamming_distance
    assert restored_tracer.overwrite_events[0].winner_strain == tracer.overwrite_events[0].winner_strain


def test_resumed_environment_can_keep_stepping(tmp_path: Path) -> None:
    environment, tracer = build_traced_environment("config/default.yaml")
    run_headless(environment, tracer, cycles=20, report_interval=20)
    checkpoint_path = tmp_path / "checkpoint"
    save_checkpoint(environment, tracer, str(checkpoint_path))

    resumed_env, resumed_tracer = resume_traced_environment(str(checkpoint_path))
    assert resumed_env.cycle == environment.cycle
    assert len(resumed_env.threads) == len(environment.threads)

    # the resumed environment must accept further .step() calls exactly
    # like a freshly-built one — hooks re-wired, no missing attributes.
    run_headless(resumed_env, resumed_tracer, cycles=20, report_interval=20)
    assert resumed_env.cycle == environment.cycle + 20


def _fake_tracer():
    from analytics.metrics import LineageRecord, OverwriteEvent, PhylogeneticTracer, SpeciationEvent

    tracer = PhylogeneticTracer(divergence_threshold=0.2)
    tracer.set_cycle(5)
    tracer.lineages[1] = LineageRecord(
        lineage_id=1,
        parent_lineage_id=None,
        origin_strain="seed",
        birth_cycle=0,
        founder_thread_id=1,
        total_births=3,
        total_deaths=1,
        alive_count=2,
    )
    tracer.speciation_events.append(
        SpeciationEvent(cycle=4, parent_lineage_id=1, child_lineage_id=2, hamming_distance=6, genome_length=24)
    )
    tracer.overwrite_events.append(
        OverwriteEvent(cycle=5, winner_lineage_id=2, loser_lineage_id=1, winner_strain="noise", loser_strain="seed")
    )
    return tracer
