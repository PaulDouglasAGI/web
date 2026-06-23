"""core/persistence.py — Checkpoint / resume.

Serializes everything needed to resume a simulation bit-for-bit into a
single ``.npz`` file: the five numpy state arrays, every live
:class:`~core.vm.Thread`, the RNG's own bit-generator state, the
:class:`~core.environment.EnvironmentConfig`, and the
:class:`~analytics.metrics.PhylogeneticTracer`'s lineage/speciation/
overwrite history.

The non-array state is JSON-encoded and stored as a single 0-d unicode
``meta`` array alongside the numpy arrays, rather than via ``pickle`` —
this keeps ``np.load`` callable with its safe default
``allow_pickle=False`` and keeps checkpoint files plain-text-inspectable.

Never serialized: ``Environment.on_birth``/``on_death``/``on_overwrite``
(closures over a specific tracer instance, meaningless across a save/load
boundary) and ``Environment._no_room_for_length`` (a cache, cheap to
re-derive and safest left unset rather than trusted blindly after a
restore). Callers re-wire the hooks on load exactly as
``main.py.build_traced_environment`` already does for a fresh
environment — see ``main.py.resume_traced_environment``.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, Tuple

import numpy as np

from analytics.metrics import LineageRecord, OverwriteEvent, PhylogeneticTracer, SpeciationEvent
from core.environment import Environment, EnvironmentConfig
from core.vm import Thread


def save_checkpoint(environment: Environment, tracer: PhylogeneticTracer, path: str) -> None:
    meta: Dict[str, Any] = {
        "config": asdict(environment.config),
        "cycle": environment.cycle,
        "next_thread_id": environment.next_thread_id,
        "next_lineage_id": environment.next_lineage_id,
        "rng_state": environment.rng.bit_generator.state,
        "threads": [_thread_to_dict(t) for t in environment.threads.values()],
        "tracer": {
            "divergence_threshold": tracer.divergence_threshold,
            "cycle": tracer._cycle,
            "lineages": [asdict(r) for r in tracer.lineages.values()],
            "speciation_events": [asdict(e) for e in tracer.speciation_events],
            "overwrite_events": [asdict(e) for e in tracer.overwrite_events],
        },
    }
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        out_path,
        memory=environment.memory,
        owner=environment.owner,
        lineage=environment.lineage,
        strain=environment.strain,
        resource=environment.resource,
        meta=np.array(json.dumps(meta)),
    )


def load_checkpoint(path: str) -> Tuple[Environment, PhylogeneticTracer]:
    # np.savez silently appends ".npz" if the caller's path lacks it, so
    # normalize here too — load_checkpoint(p) must work for the exact same
    # ``p`` a prior save_checkpoint(..., p) call was given.
    npz_path = path if str(path).endswith(".npz") else f"{path}.npz"
    with np.load(npz_path) as data:
        meta = json.loads(str(data["meta"]))
        config = EnvironmentConfig(**meta["config"])
        rng = np.random.default_rng()
        rng.bit_generator.state = meta["rng_state"]
        environment = Environment(config=config, rng=rng)
        environment.memory = data["memory"].copy()
        environment.owner = data["owner"].copy()
        environment.lineage = data["lineage"].copy()
        environment.strain = data["strain"].copy()
        environment.resource = data["resource"].copy()
        environment.cycle = meta["cycle"]
        environment.next_thread_id = meta["next_thread_id"]
        environment.next_lineage_id = meta["next_lineage_id"]
        environment.threads = {
            thread.thread_id: thread for thread in (_thread_from_dict(d) for d in meta["threads"])
        }

    tracer_meta = meta["tracer"]
    tracer = PhylogeneticTracer(divergence_threshold=tracer_meta["divergence_threshold"])
    tracer.set_cycle(tracer_meta["cycle"])
    tracer.lineages = {record["lineage_id"]: LineageRecord(**record) for record in tracer_meta["lineages"]}
    tracer.speciation_events = [SpeciationEvent(**event) for event in tracer_meta["speciation_events"]]
    tracer.overwrite_events = [OverwriteEvent(**event) for event in tracer_meta["overwrite_events"]]
    return environment, tracer


def _thread_to_dict(thread: Thread) -> Dict[str, Any]:
    data = asdict(thread)
    data["tasks_completed"] = sorted(data["tasks_completed"])  # set -> JSON-safe, deterministic list
    return data


def _thread_from_dict(data: Dict[str, Any]) -> Thread:
    data = dict(data)
    data["tasks_completed"] = set(data["tasks_completed"])
    return Thread(**data)
