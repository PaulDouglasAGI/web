"""core/initializer.py — The Hybrid Primordial Matrix.

Builds the very first state of the universe: a flat memory lattice split
into a "Pure Noise Sector" (pure chaotic bytes, for observing spontaneous
abiogenesis) and a "Seeded Sector" (chaotic bytes with hand-crafted
"Ancestor" self-replicators injected at evenly spaced coordinates), driven
by a runtime YAML or JSON configuration file.

The Ancestor genome
--------------------
A 24-byte infinite loop: ``ALLOC -> READ_HEAD -> [spacer] -> WRITE_HEAD ->
JMP back to the loop``. Per ``core/vm.py``'s design decisions, READ_HEAD/
WRITE_HEAD auto-advance their own heads (satisfying the "INC pointers"
step) and JMP locates the loop entry point via complement-template
matching against a single NOP "label" byte placed immediately *before*
ALLOC. Because ALLOC is re-entrant (a no-op, at reduced cost, whenever a
previous offspring buffer is still being written — see ``core/vm.py``'s
design decision #5), putting it inside the loop is safe: each pass either
opens a fresh offspring buffer (the moment the previous one finalizes) or
quietly does nothing (while a copy is still in progress), so a single
organism keeps spawning new offspring for as long as it lives, instead of
getting only one reproduction event in its entire lifetime.

READ_HEAD and WRITE_HEAD are deliberately *not* adjacent. Per
``core/vm.py``'s design decision #1, the active register for these
instructions is a pure function of the instruction's own absolute address
parity — and since address parity always alternates between consecutive
bytes, two genuinely adjacent instructions would always land on opposite
registers, making WRITE_HEAD permanently read a register READ_HEAD never
wrote to (silently copying zeros forever). A one-byte INC spacer between
them keeps both at the same parity (their addresses differ by 2, not 1),
so WRITE_HEAD always reads the very value READ_HEAD just loaded,
regardless of where this genome is placed in memory. The spacer INC
operates on the *other* register (by construction, the one parity away)
and is otherwise harmless. The remaining padding after the JMP template is
filled with INC (0x01), never NOP (0x00), specifically so it cannot
accidentally satisfy the loop's own jump template before genuinely
wrapping around to the real loop label — and because INC is harmless
filler if a stray IP or mutation ever wanders into it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import yaml

from core.environment import Environment, EnvironmentConfig
from core.vm import IllegalOpcodeError, Opcode

ANCESTOR_GENOME_LENGTH = 24


def build_ancestor_genome() -> bytes:
    """Construct the canonical 24-byte ALLOC / READ_HEAD / WRITE_HEAD / JMP
    self-replicator described in the lab specification."""
    genome = bytearray(ANCESTOR_GENOME_LENGTH)
    genome[0] = Opcode.NOP  # loop label: JMP's landing pad
    genome[1] = Opcode.ALLOC
    genome[2] = Opcode.READ_HEAD
    genome[3] = Opcode.INC  # parity spacer — keeps WRITE_HEAD's address parity == READ_HEAD's
    genome[4] = Opcode.WRITE_HEAD
    genome[5] = Opcode.JMP
    genome[6] = 0xFF  # template whose complement (0x00) matches the loop label
    for offset in range(7, ANCESTOR_GENOME_LENGTH):
        genome[offset] = Opcode.INC
    # offset 6 is JMP's operand byte — pure data, never landed on as an IP
    # position by this program's own control flow, so it is exempt from
    # opcode validation.
    validate_genome(bytes(genome), data_offsets=frozenset({6}))
    return bytes(genome)


def validate_genome(genome: bytes, data_offsets: frozenset[int] = frozenset()) -> None:
    """Raise :class:`IllegalOpcodeError` if a hand-crafted genome contains a
    byte outside the closed 0x00-0x07 ISA, other than at ``data_offsets``
    (positions known to hold instruction operands rather than opcodes —
    e.g. a JMP's template byte). This is an authoring-time error boundary;
    it has nothing to do with the runtime "illegal opcode" event that
    noise-derived organisms routinely (and correctly) trigger.
    """
    for offset, byte_value in enumerate(genome):
        if offset in data_offsets:
            continue
        if byte_value > Opcode.SHARE:
            raise IllegalOpcodeError(offset, byte_value)


@dataclass
class PrimordialMatrixConfig:
    """Everything the initializer itself needs, on top of the physics
    constants already captured by :class:`core.environment.EnvironmentConfig`.
    """

    noise_fraction: float = 0.5
    seed_instances: int = 12
    random_seed: Optional[int] = None


def load_config_file(path: str) -> Dict[str, Any]:
    """Load a runtime configuration file. Supports YAML (``.yml``/``.yaml``)
    and JSON (``.json``) based on the file extension.
    """
    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(f"no configuration file at {path!r}")
    text = file_path.read_text(encoding="utf-8")
    if file_path.suffix.lower() in (".yml", ".yaml"):
        loaded = yaml.safe_load(text)
    elif file_path.suffix.lower() == ".json":
        loaded = json.loads(text)
    else:
        raise ValueError(f"unsupported configuration format: {file_path.suffix!r}")
    if not isinstance(loaded, dict):
        raise ValueError(f"configuration file {path!r} did not contain a mapping at its root")
    return loaded


def _split_config(raw: Dict[str, Any]) -> tuple[EnvironmentConfig, PrimordialMatrixConfig]:
    env_fields = set(EnvironmentConfig.__dataclass_fields__)
    matrix_fields = set(PrimordialMatrixConfig.__dataclass_fields__)
    env_kwargs = {k: v for k, v in raw.items() if k in env_fields}
    matrix_kwargs = {k: v for k, v in raw.items() if k in matrix_fields}
    unknown = set(raw) - env_fields - matrix_fields
    if unknown:
        raise ValueError(f"unrecognized configuration keys: {sorted(unknown)}")
    return EnvironmentConfig(**env_kwargs), PrimordialMatrixConfig(**matrix_kwargs)


def build_environment(config_path: Optional[str] = None) -> Environment:
    """Top-level orchestration: load configuration (or fall back to
    built-in defaults), allocate the memory lattice, partition it into the
    Pure Noise Sector and Seeded Sector, and return a fully-seeded
    :class:`Environment` ready to be stepped.

    This deliberately returns a plain, hook-free :class:`Environment` —
    callers that want a :class:`analytics.metrics.PhylogeneticTracer`
    wired up (e.g. ``main.py``) attach its hooks afterward and replay the
    already-seeded Ancestors into it, rather than threading hook
    parameters through here. See ``main.py``'s ``build_traced_environment``.
    """
    raw_config: Dict[str, Any] = load_config_file(config_path) if config_path else {}
    env_config, matrix_config = _split_config(raw_config)
    rng = np.random.default_rng(matrix_config.random_seed)
    environment = Environment(config=env_config, rng=rng)

    size = env_config.size
    noise_byte_count = int(size * matrix_config.noise_fraction)

    # Fill the entire lattice with chaotic bytes first — both sectors start
    # as raw noise; only the Seeded Sector additionally receives ancestors.
    environment.memory[:] = rng.integers(0, 256, size=size, dtype=np.uint8)

    _inject_ancestors(environment, matrix_config, seeded_sector_start=noise_byte_count)
    return environment


def _inject_ancestors(
    environment: Environment, matrix_config: PrimordialMatrixConfig, seeded_sector_start: int
) -> None:
    """Place evenly-spaced copies of the Ancestor genome across the Seeded
    Sector, each becoming the founding member of its own lineage.
    """
    ancestor = build_ancestor_genome()
    size = environment.memory.size
    seeded_sector_length = size - seeded_sector_start
    if matrix_config.seed_instances <= 0:
        return
    spacing = max(ANCESTOR_GENOME_LENGTH, seeded_sector_length // matrix_config.seed_instances)
    for index in range(matrix_config.seed_instances):
        address = seeded_sector_start + index * spacing
        if address + ANCESTOR_GENOME_LENGTH > size:
            break
        environment.spawn_organism(genome=ancestor, address=address, strain="seed")
