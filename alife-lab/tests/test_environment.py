"""Phase-2 verification tests for core/environment.py and
core/initializer.py — the thermodynamic substrate and the primordial
matrix built on top of the already-verified VM (tests/test_vm.py).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.environment import Environment, EnvironmentConfig, STRAIN_NOISE, STRAIN_SEED  # noqa: E402
from core.vm import EnergyExhaustionError, Opcode, Thread  # noqa: E402
from core.initializer import (  # noqa: E402
    ANCESTOR_GENOME_LENGTH,
    PrimordialMatrixConfig,
    _split_config,
    build_ancestor_genome,
    build_environment,
    load_config_file,
    validate_genome,
)


# ---------------------------------------------------------------------------
# Environment physics
# ---------------------------------------------------------------------------

def make_env(**overrides) -> Environment:
    config = EnvironmentConfig(
        width=8, height=8, probe_spawn_count=0, mutation_rate=0.0, **overrides
    )
    return Environment(config=config, rng=np.random.default_rng(42))


def test_environment_config_size_property() -> None:
    config = EnvironmentConfig(width=16, height=4)
    assert config.size == 64


def test_harvest_energy_depletes_and_caps_resource() -> None:
    env = make_env(baseline_resource=4.0, max_resource=10.0)
    env.resource[0] = 3.0
    drawn = env.harvest_energy(0, 5.0)
    assert drawn == pytest.approx(3.0)
    assert env.resource[0] == pytest.approx(0.0)

    deposited = env.harvest_energy(0, -100.0)
    assert deposited == 0.0
    assert env.resource[0] == pytest.approx(10.0)  # clamped to max_resource


def test_write_byte_succeeds_into_unowned_space() -> None:
    env = make_env()
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    assert env.write_byte(5, 0xAB, thread) is True
    assert env.read_byte(5) == 0xAB


def test_write_byte_collision_higher_energy_wins() -> None:
    env = make_env()
    weak = Thread(thread_id=1, genome_start=0, genome_length=4, energy=5.0)
    strong = Thread(thread_id=2, genome_start=10, genome_length=4, energy=50.0)
    env.threads = {1: weak, 2: strong}

    # a weak attacker cannot dislodge a stronger resident's claim
    env.owner[5] = strong.thread_id
    assert env.write_byte(5, 0x11, weak) is False
    assert env.owner[5] == strong.thread_id

    # but a strong attacker can overwrite a weaker resident's claim,
    # and ownership of that address transfers to the winner
    env.owner[6] = weak.thread_id
    assert env.write_byte(6, 0x22, strong) is True
    assert env.read_byte(6) == 0x22
    assert env.owner[6] == strong.thread_id

    # writing into a claim you already own always succeeds
    assert env.write_byte(5, 0x33, strong) is True
    assert env.read_byte(5) == 0x33


def test_request_allocation_prefers_adjacent_free_space() -> None:
    env = make_env()
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[0:4] = 1
    start = env.request_allocation(thread)
    assert start == 4  # immediately to the right
    assert np.all(env.owner[4:8] == 1)


def test_request_allocation_falls_back_to_random_free_region() -> None:
    env = make_env()
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[:] = 99  # nothing adjacent is free
    size = env.memory.size
    free_start = 40
    env.owner[free_start:free_start + 4] = -1
    start = env.request_allocation(thread)
    assert start == free_start


def test_request_allocation_returns_none_when_universe_is_full() -> None:
    env = make_env()
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[:] = 99  # not a single free byte anywhere
    assert env.request_allocation(thread) is None


def test_finalize_offspring_splits_energy_and_registers_child() -> None:
    env = make_env(offspring_energy_share=0.4)
    parent = Thread(thread_id=1, genome_start=0, genome_length=4, energy=100.0, lineage_id=7, strain="seed")
    parent.offspring_start = 20
    parent.offspring_length = 4
    env.threads[1] = parent

    env.finalize_offspring(parent)

    assert parent.energy == pytest.approx(60.0)
    children = [t for t in env.threads.values() if t.parent_id == 1]
    assert len(children) == 1
    child = children[0]
    assert child.energy == pytest.approx(40.0)
    assert child.lineage_id == 7
    assert child.generation == 1
    assert np.all(env.owner[20:24] == child.thread_id)
    assert np.all(env.strain[20:24] == STRAIN_SEED)


def test_finalize_offspring_without_claimed_buffer_raises() -> None:
    env = make_env()
    parent = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    with pytest.raises(EnergyExhaustionError):
        env.finalize_offspring(parent)


def test_spawn_organism_rejects_non_positive_initial_energy() -> None:
    env = make_env(initial_energy=0.0)
    with pytest.raises(EnergyExhaustionError):
        env.spawn_organism(genome=bytes([Opcode.NOP]), address=0, strain="seed")


def test_step_reclaims_dead_threads_into_background_noise() -> None:
    env = make_env(baseline_resource=0.0)  # a barren cell: no ambient energy to offset the cost
    dying = Thread(thread_id=1, genome_start=0, genome_length=4, energy=0.5)
    env.threads[1] = dying
    env.owner[0:4] = 1
    env.lineage[0:4] = 9
    env.strain[0:4] = STRAIN_SEED
    env.memory[0:4] = Opcode.NOP

    stats = env.step()

    assert stats.deaths == 1
    assert 1 not in env.threads
    assert np.all(env.owner[0:4] == -1)
    assert np.all(env.lineage[0:4] == -1)
    assert np.all(env.strain[0:4] == 0)


def test_population_by_strain_counts_only_living_threads() -> None:
    env = make_env()
    env.threads = {
        1: Thread(thread_id=1, genome_start=0, genome_length=1, strain="seed", alive=True),
        2: Thread(thread_id=2, genome_start=1, genome_length=1, strain="noise", alive=True),
        3: Thread(thread_id=3, genome_start=2, genome_length=1, strain="seed", alive=False),
    }
    counts = env.population_by_strain()
    assert counts == {"seed": 1, "noise": 1}


# ---------------------------------------------------------------------------
# Initializer
# ---------------------------------------------------------------------------

def test_build_ancestor_genome_has_correct_length_and_structure() -> None:
    genome = build_ancestor_genome()
    assert len(genome) == ANCESTOR_GENOME_LENGTH
    assert genome[0] == Opcode.ALLOC
    assert genome[1] == Opcode.NOP
    assert genome[2] == Opcode.READ_HEAD
    assert genome[3] == Opcode.WRITE_HEAD
    assert genome[4] == Opcode.JMP
    assert genome[5] == 0xFF
    assert all(b == Opcode.INC for b in genome[6:])


def test_validate_genome_raises_on_illegal_byte() -> None:
    from core.vm import IllegalOpcodeError

    with pytest.raises(IllegalOpcodeError):
        validate_genome(bytes([Opcode.NOP, 0xEE, Opcode.INC]))


def test_validate_genome_skips_declared_data_offsets() -> None:
    validate_genome(bytes([Opcode.JMP, 0xFF]), data_offsets=frozenset({1}))


def test_load_config_file_yaml_and_json(tmp_path: Path) -> None:
    payload = {"width": 32, "height": 32, "seed_instances": 3}
    yaml_path = tmp_path / "config.yaml"
    yaml_path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    json_path = tmp_path / "config.json"
    json_path.write_text(json.dumps(payload), encoding="utf-8")

    assert load_config_file(str(yaml_path)) == payload
    assert load_config_file(str(json_path)) == payload


def test_load_config_file_missing_raises() -> None:
    with pytest.raises(FileNotFoundError):
        load_config_file("/nonexistent/path/config.yaml")


def test_split_config_rejects_unknown_keys() -> None:
    with pytest.raises(ValueError):
        _split_config({"not_a_real_field": 1})


def test_split_config_routes_fields_to_correct_dataclass() -> None:
    env_config, matrix_config = _split_config({"width": 99, "seed_instances": 5})
    assert env_config.width == 99
    assert matrix_config.seed_instances == 5


def test_build_environment_with_defaults_creates_seeded_population() -> None:
    env = build_environment(config_path=None)
    assert len(env.threads) > 0
    assert all(t.strain == "seed" for t in env.threads.values())


# ---------------------------------------------------------------------------
# End-to-end integration: a single seeded ancestor must, eventually,
# replicate — this is the load-bearing proof that the ISA, the substrate,
# and the ancestor program are all mutually consistent.
# ---------------------------------------------------------------------------

def test_single_ancestor_replicates_within_a_bounded_number_of_cycles() -> None:
    config = EnvironmentConfig(
        width=32,
        height=32,
        probe_spawn_count=0,
        mutation_rate=0.0,
        baseline_resource=8.0,
        max_resource=64.0,
        initial_energy=400.0,
    )
    env = Environment(config=config, rng=np.random.default_rng(7))
    env.memory[:] = 0  # NOP sea, so a stray IP never finds a spurious opcode
    ancestor = build_ancestor_genome()
    env.spawn_organism(genome=ancestor, address=0, strain="seed")

    total_replications = 0
    for _ in range(2000):
        stats = env.step()
        total_replications += stats.replications
        if total_replications > 0:
            break

    assert total_replications > 0
    assert len(env.threads) >= 2
