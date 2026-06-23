"""Phase-1 verification tests for core/vm.py — the CPU substrate in total
isolation from any concrete environment, using a minimal fake substrate
that satisfies the ``Substrate`` protocol.

Per the build instructions, these must pass before any environment,
analytics, or visualization code is layered on top of the VM.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.vm import (  # noqa: E402
    CPUCore,
    EXHAUSTION_THRESHOLD,
    ExecutionResult,
    Opcode,
    Thread,
    VMError,
)


class FakeSubstrate:
    """A trivial in-memory substrate: unlimited energy, no write collisions,
    one fixed adjacent allocation slot. Just enough to exercise every
    opcode's semantics without pulling in core/environment.py.
    """

    def __init__(self, memory: bytes, alloc_at: Optional[int] = None) -> None:
        self.memory: bytearray = bytearray(memory)
        self._alloc_at = alloc_at
        self.finalized: List[int] = []
        self.write_log: List[Tuple[int, int]] = []
        self.block_writes_to: set[int] = set()
        self.allocation_requests: int = 0

    def read_byte(self, address: int) -> int:
        return self.memory[address % len(self.memory)]

    def write_byte(self, address: int, value: int, thread: Thread) -> bool:
        if address in self.block_writes_to:
            return False
        self.memory[address % len(self.memory)] = value & 0xFF
        self.write_log.append((address, value & 0xFF))
        return True

    def request_allocation(self, thread: Thread) -> Optional[int]:
        self.allocation_requests += 1
        return self._alloc_at

    def harvest_energy(self, address: int, amount: float) -> float:
        # A barren fake world: no ambient energy to draw on, so every
        # instruction's cost is a pure net deduction — keeps these isolated
        # opcode-semantics tests independent of any resource-physics model.
        return 0.0

    def finalize_offspring(self, parent: Thread) -> None:
        self.finalized.append(parent.thread_id)


def make_thread(genome_start: int, genome_length: int, **overrides) -> Thread:
    defaults = dict(thread_id=1, genome_start=genome_start, genome_length=genome_length, energy=100.0)
    defaults.update(overrides)
    return Thread(**defaults)


def test_nop_costs_energy_and_advances_ip() -> None:
    substrate = FakeSubstrate(bytes([Opcode.NOP, Opcode.NOP]))
    thread = make_thread(0, 2)
    result = CPUCore().execute(thread, substrate)
    assert result.opcode is Opcode.NOP
    assert thread.ip == 1
    assert thread.energy == pytest.approx(99.0)


def test_inc_dec_use_address_parity_for_active_register() -> None:
    # INC at even address 0 -> reg_a; DEC at odd address 1 -> reg_b
    substrate = FakeSubstrate(bytes([Opcode.INC, Opcode.DEC]))
    thread = make_thread(0, 2, reg_a=10, reg_b=10)
    CPUCore().execute(thread, substrate)  # executes INC at address 0
    assert thread.reg_a == 11 and thread.reg_b == 10
    CPUCore().execute(thread, substrate)  # ip now 1, executes DEC at address 1
    assert thread.reg_a == 11 and thread.reg_b == 9


def test_inc_register_wraps_at_8_bit_boundary() -> None:
    substrate = FakeSubstrate(bytes([Opcode.INC]))
    thread = make_thread(0, 1, reg_a=255)
    CPUCore().execute(thread, substrate)
    assert thread.reg_a == 0  # wrapped, still an 8-bit register


def test_jmp_finds_complement_template_and_lands_after_it() -> None:
    # genome: JMP(0x03) TEMPLATE(0xFF) INC INC NOP(0x00 == complement of 0xFF) INC
    # JMP's template operand 0xFF has complement 0x00, which is the lone NOP at
    # offset 4; execution should resume at offset 5 (the INC right after it).
    genome = bytes([Opcode.JMP, 0xFF, Opcode.INC, Opcode.INC, Opcode.NOP, Opcode.INC])
    substrate = FakeSubstrate(genome)
    thread = make_thread(0, len(genome))
    result = CPUCore().execute(thread, substrate)
    assert result.jumped is True
    assert thread.ip == 5


def test_jmp_with_no_matching_template_falls_through() -> None:
    genome = bytes([Opcode.JMP, 0x00, Opcode.INC])  # complement of 0x00 is 0xFF, never present
    substrate = FakeSubstrate(genome)
    thread = make_thread(0, len(genome))
    result = CPUCore().execute(thread, substrate)
    assert result.jumped is False
    assert thread.ip == 2  # advanced past the 2-byte JMP instruction


def test_alloc_claims_offspring_buffer() -> None:
    substrate = FakeSubstrate(bytes([Opcode.ALLOC]), alloc_at=100)
    thread = make_thread(0, 1)
    CPUCore().execute(thread, substrate)
    assert thread.offspring_start == 100
    assert thread.offspring_length == thread.genome_length


def test_alloc_failure_leaves_thread_without_offspring() -> None:
    substrate = FakeSubstrate(bytes([Opcode.ALLOC]), alloc_at=None)
    thread = make_thread(0, 1)
    CPUCore().execute(thread, substrate)
    assert thread.offspring_start is None


def test_alloc_while_offspring_in_progress_is_a_cheap_no_op() -> None:
    from core.vm import ALLOC_RETRY_COST, INSTRUCTION_COSTS

    substrate = FakeSubstrate(bytes([Opcode.ALLOC]), alloc_at=100)
    thread = make_thread(0, 1, offspring_start=50, offspring_length=4, offspring_progress=1)
    CPUCore().execute(thread, substrate)
    assert substrate.allocation_requests == 0  # never re-requested
    assert thread.offspring_start == 50  # the in-progress buffer is untouched
    assert thread.energy == pytest.approx(100.0 - ALLOC_RETRY_COST)
    assert ALLOC_RETRY_COST < INSTRUCTION_COSTS[Opcode.ALLOC]


def test_alloc_opens_a_new_buffer_once_the_previous_one_is_clear() -> None:
    substrate = FakeSubstrate(bytes([Opcode.ALLOC]), alloc_at=100)
    thread = make_thread(0, 1, offspring_start=None)  # previous offspring already finalized
    CPUCore().execute(thread, substrate)
    assert substrate.allocation_requests == 1
    assert thread.offspring_start == 100


def test_read_head_loads_register_and_advances() -> None:
    genome = bytes([Opcode.READ_HEAD, 0xAB])
    substrate = FakeSubstrate(genome)
    thread = make_thread(0, len(genome), read_head=1)
    CPUCore().execute(thread, substrate)
    assert thread.reg_a == 0xAB  # address 0 is even -> reg_a
    assert thread.read_head == 0  # advanced and wrapped (len=2)


def test_write_head_copies_register_and_replicates_on_completion() -> None:
    genome = bytes([Opcode.WRITE_HEAD])
    substrate = FakeSubstrate(genome, alloc_at=50)
    thread = make_thread(0, 1, reg_a=0x42)
    thread.offspring_start = 50
    thread.offspring_length = 1  # a one-byte offspring: this single write finishes it
    result = CPUCore().execute(thread, substrate)
    assert substrate.write_log == [(50, 0x42)]
    assert result.replicated is True
    assert substrate.finalized == [thread.thread_id]
    assert thread.offspring_start is None


def test_write_head_blocked_by_collision_does_not_advance() -> None:
    genome = bytes([Opcode.WRITE_HEAD])
    substrate = FakeSubstrate(genome, alloc_at=50)
    substrate.block_writes_to.add(50)
    thread = make_thread(0, 1, reg_a=0x42)
    thread.offspring_start = 50
    thread.offspring_length = 4
    CPUCore().execute(thread, substrate)
    assert thread.write_head == 0
    assert thread.offspring_progress == 0


def test_share_diffuses_energy_to_neighbor() -> None:
    substrate = FakeSubstrate(bytes([Opcode.SHARE]))
    thread = make_thread(0, 1, energy=50.0)
    CPUCore().execute(thread, substrate)
    # 10% of 50.0 pre-cost energy is shared away in addition to the opcode cost
    assert thread.energy < 50.0 - 1.8


def test_illegal_opcode_charges_steep_energy_without_raising() -> None:
    substrate = FakeSubstrate(bytes([0x55]))  # not in 0x00-0x07
    thread = make_thread(0, 1, energy=100.0)
    result = CPUCore().execute(thread, substrate)
    assert result.illegal is True
    assert thread.energy == pytest.approx(94.0)
    assert thread.alive is True


def test_energy_exhaustion_kills_thread() -> None:
    substrate = FakeSubstrate(bytes([Opcode.NOP]))
    thread = make_thread(0, 1, energy=0.5)
    result = CPUCore().execute(thread, substrate)
    assert thread.alive is False
    assert result.died is True


def test_repeated_illegal_opcodes_eventually_exhaust_thread() -> None:
    substrate = FakeSubstrate(bytes([0xEE]))
    thread = make_thread(0, 1, energy=10.0)
    core = CPUCore()
    died = False
    for _ in range(5):
        if not thread.alive:
            break
        result = core.execute(thread, substrate)
        died = died or result.died
    assert died is True
    assert thread.alive is False


def test_cannot_execute_a_dead_thread() -> None:
    substrate = FakeSubstrate(bytes([Opcode.NOP]))
    thread = make_thread(0, 1, energy=0.0)
    thread.alive = False
    with pytest.raises(VMError):
        CPUCore().execute(thread, substrate)


def test_absolute_head_helpers_respect_genome_offset_and_wrap() -> None:
    thread = make_thread(genome_start=1000, genome_length=10, ip=12, read_head=27)
    assert thread.absolute_ip() == 1000 + (12 % 10)
    assert thread.absolute_read_head() == 1000 + (27 % 10)


def test_absolute_write_head_requires_claimed_buffer() -> None:
    thread = make_thread(0, 4)
    with pytest.raises(VMError):
        thread.absolute_write_head()
