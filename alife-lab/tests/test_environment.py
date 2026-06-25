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

    # Depositing 100 into an empty cell capped at 10 absorbs only 10; the
    # return value reports how much actually landed, so callers (e.g. SHARE)
    # can avoid destroying the overflow.
    deposited = env.harvest_energy(0, -100.0)
    assert deposited == pytest.approx(10.0)
    assert env.resource[0] == pytest.approx(10.0)  # clamped to max_resource

    # A deposit into an already-full cell absorbs nothing.
    assert env.harvest_energy(0, -5.0) == pytest.approx(0.0)
    assert env.resource[0] == pytest.approx(10.0)


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


def test_request_allocation_prefers_nearby_slot_over_far_fallback() -> None:
    config = EnvironmentConfig(
        width=32, height=32, probe_spawn_count=0, mutation_rate=0.0, local_search_radius=2
    )
    env = Environment(config=config, rng=np.random.default_rng(42))
    thread = Thread(thread_id=1, genome_start=500, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[:] = 99  # occupy the entire universe by default
    env.owner[496:508] = 1  # the organism's own genome plus both adjacent slots
    env.owner[492:496] = -1  # one free slot within the local search radius
    env.owner[600:604] = -1  # a free slot far outside the local search radius
    start = env.request_allocation(thread)
    assert start == 492  # the nearby slot wins over the distant one
    assert np.all(env.owner[492:496] == 1)


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


def test_request_allocation_random_probe_finds_a_distant_free_region() -> None:
    # Regression guard for the bounded-random-probe optimization ahead of
    # the exhaustive global scan: a free region far outside both the
    # immediate-adjacent slots and the local search radius must still be
    # found (not just "None returned because the cheap path gave up").
    config = EnvironmentConfig(
        width=256, height=256, probe_spawn_count=0, mutation_rate=0.0, local_search_radius=2
    )
    env = Environment(config=config, rng=np.random.default_rng(3))
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[:] = 99  # nothing nearby or adjacent is free
    free_region_start, free_region_length = 40000, 2000
    env.owner[free_region_start:free_region_start + free_region_length] = -1
    start = env.request_allocation(thread)
    assert start is not None
    assert free_region_start <= start <= free_region_start + free_region_length - thread.genome_length
    assert np.all(env.owner[start:start + thread.genome_length] == thread.thread_id)


def test_request_allocation_caches_no_room_to_skip_repeated_full_scans() -> None:
    # Once an exhaustive scan confirms no free run exists anywhere, a
    # second call for the same (or longer) length must short-circuit
    # straight to None rather than repeating the expensive search tiers.
    env = make_env()
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[:] = 99  # not a single free byte anywhere
    assert env.request_allocation(thread) is None
    assert env._no_room_for_length == 4

    # Quietly free a slot directly, bypassing _reclaim, so the only way
    # this could be found is if the cache were (incorrectly) consulted —
    # i.e. confirm the short-circuit is actually taken, not just harmless.
    env.owner[10:14] = -1
    assert env.request_allocation(thread) is None


def test_request_allocation_no_room_cache_clears_after_reclaim() -> None:
    config = EnvironmentConfig(
        width=256, height=256, probe_spawn_count=0, mutation_rate=0.0, local_search_radius=2
    )
    env = Environment(config=config, rng=np.random.default_rng(3))
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=10.0)
    env.threads[1] = thread
    env.owner[:] = 99  # not a single free byte anywhere
    assert env.request_allocation(thread) is None
    assert env._no_room_for_length == 4

    dead = Thread(thread_id=2, genome_start=40000, genome_length=4, energy=0.0)
    env.threads[2] = dead
    env.owner[40000:40004] = 2
    env._reclaim(dead)
    assert env._no_room_for_length is None

    start = env.request_allocation(thread)
    assert start == 40000
    assert np.all(env.owner[40000:40004] == thread.thread_id)


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


def test_senescence_kills_a_thread_with_ample_resources_over_time() -> None:
    # With senescence_rate set, energy harvested to exactly cover each
    # instruction's cost (the normal steady-state case, since baseline
    # resource is abundant) must still drain away and eventually kill the
    # thread — the whole point of senescence is that it bypasses the
    # harvest/cost balance that would otherwise let energy stay flat
    # forever.
    env = make_env(baseline_resource=1000.0, max_resource=1000.0, senescence_rate=1.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=2.0)
    env.threads[1] = thread
    env.owner[0:4] = 1
    env.memory[0:4] = Opcode.NOP

    stats = env.step()
    assert thread.energy == pytest.approx(1.0)  # NOP cost (1.0) fully harvested, then senescence
    assert stats.deaths == 0

    stats = env.step()
    assert stats.deaths == 1
    assert 1 not in env.threads


def test_senescence_rate_zero_leaves_energy_unaffected() -> None:
    env = make_env(baseline_resource=1000.0, max_resource=1000.0, senescence_rate=0.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=2.5)
    env.threads[1] = thread
    env.owner[0:4] = 1
    env.memory[0:4] = Opcode.NOP

    env.step()
    assert thread.energy == pytest.approx(2.5)  # NOP cost fully offset by harvest, no decay


def test_task_bonus_deposits_resource_at_threads_address_on_match() -> None:
    env = make_env(baseline_resource=0.0, max_resource=1000.0, task_bonus_energy=10.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=1, energy=10.0)
    thread.recent_inputs = [0x0F, 0xF0]
    thread.reg_a = 0x0F  # IO_OUT at address 0 (even -> reg_a) outputs NOT(0xF0) & 0xFF
    env.threads[1] = thread
    env.owner[0] = 1
    env.memory[0] = Opcode.IO_OUT

    stats = env.step()
    assert "not" in thread.tasks_completed
    assert env.resource[0] == pytest.approx(10.0)
    assert stats.deaths == 0


def test_task_bonus_is_not_paid_twice_for_an_already_completed_task() -> None:
    env = make_env(baseline_resource=0.0, max_resource=1000.0, task_bonus_energy=10.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=1, energy=10.0)
    thread.recent_inputs = [0x0F, 0xF0]
    thread.reg_a = 0x0F
    thread.tasks_completed = {"not"}  # already rewarded in a previous cycle
    env.threads[1] = thread
    env.owner[0] = 1
    env.memory[0] = Opcode.IO_OUT

    env.step()
    assert env.resource[0] == pytest.approx(0.0)  # no second payout


def test_task_bonus_energy_zero_pays_nothing() -> None:
    env = make_env(baseline_resource=0.0, max_resource=1000.0, task_bonus_energy=0.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=1, energy=10.0)
    thread.recent_inputs = [0x0F, 0xF0]
    thread.reg_a = 0x0F
    env.threads[1] = thread
    env.owner[0] = 1
    env.memory[0] = Opcode.IO_OUT

    env.step()
    assert "not" in thread.tasks_completed  # task semantics still recorded
    assert env.resource[0] == pytest.approx(0.0)  # but no payout when disabled


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
    assert genome[0] == Opcode.NOP
    assert genome[1] == Opcode.ALLOC
    assert genome[2] == Opcode.READ_HEAD
    assert genome[3] == Opcode.INC  # parity spacer
    assert genome[4] == Opcode.WRITE_HEAD
    assert genome[5] == Opcode.JMP
    assert genome[6] == 0xFF
    assert all(b == Opcode.INC for b in genome[7:])


def test_ancestor_genome_keeps_read_and_write_head_at_matching_address_parity() -> None:
    # The bug this guards against: if READ_HEAD and WRITE_HEAD ever end up at
    # opposite address parity, WRITE_HEAD always reads a register READ_HEAD
    # never wrote to, so every byte copied into an offspring is silently 0
    # regardless of the parent's actual genome — see core/vm.py design
    # decision #1 and core/initializer.py's "Ancestor genome" docstring.
    genome = build_ancestor_genome()
    read_head_offset = genome.index(Opcode.READ_HEAD)
    write_head_offset = genome.index(Opcode.WRITE_HEAD)
    assert read_head_offset % 2 == write_head_offset % 2


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


def test_replicated_offspring_genome_faithfully_copies_the_parent() -> None:
    # Regression guard for a previously latent bug: WRITE_HEAD must read the
    # very register READ_HEAD last populated, or every copied byte is
    # silently 0 regardless of the parent's real genome (see
    # core/initializer.py's "Ancestor genome" docstring).
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
    env.memory[:] = 0
    ancestor = build_ancestor_genome()
    parent = env.spawn_organism(genome=ancestor, address=0, strain="seed")

    for _ in range(2000):
        stats = env.step()
        if stats.replications > 0:
            break

    children = [t for t in env.threads.values() if t.parent_id == parent.thread_id]
    assert len(children) >= 1
    child = children[0]
    child_genome = bytes(env.memory[child.genome_start:child.genome_start + child.genome_length])
    assert child_genome == ancestor


def test_single_ancestor_reproduces_more_than_once_in_its_lifetime() -> None:
    """ALLOC is re-entrant (core/vm.py design decision #5): the founding
    Ancestor's loop body keeps calling ALLOC, so the same parent thread
    should still be alive and spawn a second offspring after its first,
    rather than becoming a sterile zombie after exactly one reproduction.
    """
    config = EnvironmentConfig(
        width=64,
        height=64,
        probe_spawn_count=0,
        mutation_rate=0.0,
        baseline_resource=8.0,
        max_resource=64.0,
        initial_energy=4000.0,
    )
    env = Environment(config=config, rng=np.random.default_rng(7))
    env.memory[:] = 0
    ancestor = build_ancestor_genome()
    parent = env.spawn_organism(genome=ancestor, address=0, strain="seed")

    total_replications = 0
    for _ in range(6000):
        stats = env.step()
        total_replications += stats.replications
        if total_replications >= 2:
            break

    assert total_replications >= 2
    assert parent.alive  # the same parent is still alive after its first birth
    children_of_parent = [t for t in env.threads.values() if t.parent_id == parent.thread_id]
    assert len(children_of_parent) >= 2


# ---------------------------------------------------------------------------
# Phase-A regression guards: the territory leak and the immortal-noise bug
# ---------------------------------------------------------------------------

def test_illegal_opcode_is_a_net_drain_even_on_a_resource_rich_cell() -> None:
    # Regression guard for the immortal-noise bug. Executing an illegal byte
    # must NOT harvest the local cell to refund its own penalty: earlier the
    # full cost was harvested back whenever the cell held at least that much,
    # so pure-noise organisms (almost entirely illegal bytes) broke exactly
    # even and persisted forever instead of burning out.
    from core.vm import ILLEGAL_OPCODE_COST

    env = make_env(baseline_resource=1000.0, max_resource=1000.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=4, energy=100.0)
    env.threads[1] = thread
    env.owner[0:4] = 1
    env.memory[0:4] = 0xEE  # an illegal opcode at every position
    resource_before = float(env.resource[0])

    result = env.cpu.execute(thread, env)

    assert result.illegal is True
    assert thread.energy == pytest.approx(100.0 - ILLEGAL_OPCODE_COST)
    assert float(env.resource[0]) == pytest.approx(resource_before)  # cell untouched


def test_pure_noise_thread_burns_out_despite_abundant_resource() -> None:
    # The whole point of the fix: a lifeless all-illegal "organism" sitting on
    # an energy-rich cell must still die within a handful of cycles.
    env = make_env(baseline_resource=1000.0, max_resource=1000.0)
    thread = Thread(thread_id=1, genome_start=0, genome_length=8, energy=30.0)
    env.threads[1] = thread
    env.owner[0:8] = 1
    env.memory[0:8] = 0xEE
    for _ in range(50):
        if not thread.alive:
            break
        env.cpu.execute(thread, env)
    assert thread.alive is False


def test_reclaim_frees_unfinished_offspring_buffer() -> None:
    # Regression guard for the territory leak: a parent that dies mid-copy
    # must release the offspring cradle it claimed at ALLOC time, not only its
    # own body — otherwise those cells stay owned by a dead thread forever.
    env = make_env()
    parent = Thread(thread_id=1, genome_start=0, genome_length=4, energy=0.0)
    parent.offspring_start = 20
    parent.offspring_length = 4
    env.threads[1] = parent
    env.owner[0:4] = 1     # the parent's own body
    env.owner[20:24] = 1   # the claimed-but-unfinished offspring buffer
    env.lineage[20:24] = 5
    env.strain[20:24] = STRAIN_SEED

    env._reclaim(parent)

    assert np.all(env.owner[0:4] == -1)    # body freed (as before)
    assert np.all(env.owner[20:24] == -1)  # cradle freed (the fix)
    assert np.all(env.lineage[20:24] == -1)
    assert np.all(env.strain[20:24] == 0)


def test_reclaim_leaves_foreign_owned_cells_in_offspring_region_untouched() -> None:
    # If a higher-energy foreign writer legitimately stole part of the cradle
    # while the parent was alive, reclaim must not clobber it on the parent's
    # death — only cells the dead parent still owns are ours to free.
    env = make_env()
    parent = Thread(thread_id=1, genome_start=0, genome_length=4, energy=0.0)
    parent.offspring_start = 20
    parent.offspring_length = 4
    env.threads[1] = parent
    env.owner[0:4] = 1
    env.owner[20:24] = 1
    env.owner[22] = 7      # a foreign thread now holds this one cell
    env.memory[22] = 123

    env._reclaim(parent)

    assert np.all(env.owner[20:22] == -1)
    assert env.owner[22] == 7          # foreign cell preserved
    assert np.all(env.owner[23:24] == -1)
    assert env.memory[22] == 123       # foreign cell's contents preserved


def test_concurrent_snapshot_reads_during_stepping_do_not_raise() -> None:
    # Thread-safety guard for dashboard / dashboard-server modes: a stats
    # reader must be able to read the live environment + tracer while the
    # simulation thread mutates the thread registry and the tracer, without
    # hitting "dictionary changed size during iteration" or a torn read.
    import threading

    from analytics.metrics import PhylogeneticTracer, take_snapshot
    from core.initializer import build_ancestor_genome

    config = EnvironmentConfig(width=32, height=32, probe_spawn_count=2, probe_genome_length=24)
    env = Environment(config=config, rng=np.random.default_rng(0))
    env.memory[:] = np.random.default_rng(0).integers(0, 256, size=config.size, dtype=np.uint8)
    tracer = PhylogeneticTracer()
    env.on_birth = lambda child, parent: tracer.on_birth(child, parent, env)
    env.on_death = tracer.on_death
    env.on_overwrite = tracer.on_overwrite
    ancestor = build_ancestor_genome()
    for address in range(0, config.size - ANCESTOR_GENOME_LENGTH, 64):
        env.spawn_organism(genome=ancestor, address=address, strain="seed")

    errors: list = []
    stop = threading.Event()

    def simulate() -> None:
        try:
            for _ in range(400):
                tracer.set_cycle(env.cycle)
                env.step()
        except Exception as exc:  # noqa: BLE001 — record any race for the assert
            errors.append(exc)
        finally:
            stop.set()

    def read() -> None:
        try:
            while not stop.is_set():
                take_snapshot(env, tracer)
                env.population_by_strain()
                env.living_threads()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    sim_thread = threading.Thread(target=simulate)
    read_thread = threading.Thread(target=read)
    sim_thread.start()
    read_thread.start()
    sim_thread.join(timeout=60)
    read_thread.join(timeout=5)

    assert not errors, errors


def test_probe_initial_energy_is_independent_of_baseline_resource() -> None:
    # The probe budget must be a fixed value, not a multiple of the resource
    # field's richness, so retuning resources never silently changes how long
    # noise probes survive.
    config = EnvironmentConfig(
        width=8,
        height=8,
        mutation_rate=0.0,
        baseline_resource=1000.0,
        max_resource=2000.0,
        probe_spawn_count=1,
        probe_genome_length=8,
        probe_initial_energy=30.0,
    )
    env = Environment(config=config, rng=np.random.default_rng(42))
    env._spawn_probe_threads()
    probes = [t for t in env.threads.values() if t.strain == "noise"]
    assert len(probes) == 1
    assert probes[0].energy == pytest.approx(30.0)
