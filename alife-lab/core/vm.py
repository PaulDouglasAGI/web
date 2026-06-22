"""core/vm.py — The Virtual Machine Substrate.

Defines the esoteric 8-bit instruction set architecture (ISA) that every
digital organism's genome is interpreted under, and the single-instruction
execution step (:class:`CPUCore`) applied to each living :class:`Thread`
once per global clock cycle.

This module is deliberately substrate-agnostic: it knows nothing about how
memory is physically laid out, how energy is harvested, or how write
collisions are arbitrated. It only knows the *protocol* (:class:`Substrate`)
that a host environment must satisfy. ``core.environment.Environment``
is the concrete substrate used by the rest of the laboratory; this
separation keeps the CPU's instruction semantics testable in total
isolation from the physics of the world it runs in.

Design decisions made to resolve ambiguity in the ISA specification
-------------------------------------------------------------------
1. **Active register selection.** The ISA exposes two general-purpose
   registers (RegA, RegB) but only one "active register" notion for
   INC/DEC/READ_HEAD/WRITE_HEAD, with no dedicated register-select opcode.
   To keep the 8-opcode ISA closed (no 9th instruction invented), the
   active register is a pure function of the instruction's own address:
   even addresses operate on RegA, odd addresses operate on RegB
   (:func:`Thread.active_register_name`). This is deterministic,
   reproducible, and lets a genome's *layout* implicitly choose which
   register a given instruction touches — an emergent property of
   address parity rather than hidden mutable CPU state.
2. **Head auto-advance.** READ_HEAD and WRITE_HEAD each advance their own
   head pointer by one position (modulo the relevant buffer length)
   immediately after the access, mirroring the copy-loop semantics of
   real digital-life substrates (Tierra/Avida h-copy instructions). The
   hand-crafted ancestor genome's "INC pointers" step (see
   ``core/initializer.py``) is therefore already satisfied by READ_HEAD/
   WRITE_HEAD themselves; explicit INC/DEC opcodes remain available
   purely for register arithmetic.
3. **JMP template matching.** JMP is a two-byte instruction: the opcode
   followed immediately by a one-byte template operand. Execution
   searches the organism's own circular genome (starting just past the
   operand, wrapping around) for the first byte equal to the *bitwise
   complement* of the template, and resumes execution immediately after
   that match. This is a single-byte simplification of Tierra's
   multi-nop template matching, adapted to a closed 8-opcode alphabet,
   and gives 0x00 (NOP) a second life as a structural jump label: a
   template byte of ``0xFF`` (the complement of ``0x00``) finds the
   nearest NOP "landing pad". If no complement is found, the jump is a
   no-op other than its energy cost.
4. **Illegal opcodes.** Only byte values ``0x00``-``0x07`` are valid
   instructions. A genome (or noise region) byte outside that range is an
   illegal opcode: it costs :data:`ILLEGAL_OPCODE_COST` energy and raises
   no exception that halts the simulation — the calling environment is
   expected to catch :class:`IllegalOpcodeError`, charge the thread, and
   let energy exhaustion (not a hard crash) be the cause of death. This
   keeps the 248/256 non-instruction byte values scientifically honest:
   spontaneous order arising from raw noise is *possible* but, as in
   reality, vanishingly rare and self-terminating.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Optional, Protocol, runtime_checkable


class Opcode(enum.IntEnum):
    """The complete, closed 8-instruction ISA. Values outside this range
    (0x08-0xFF) are not instructions and are illegal opcodes by design."""

    NOP = 0x00
    INC = 0x01
    DEC = 0x02
    JMP = 0x03
    ALLOC = 0x04
    READ_HEAD = 0x05
    WRITE_HEAD = 0x06
    SHARE = 0x07


#: Thermodynamic energy cost charged for executing each opcode. ALLOC is the
#: most expensive (5x NOP) per the spec; READ_HEAD/WRITE_HEAD/SHARE sit
#: between NOP and ALLOC since they move bytes/energy rather than just
#: spending a tick.
INSTRUCTION_COSTS: dict[Opcode, float] = {
    Opcode.NOP: 1.0,
    Opcode.INC: 1.2,
    Opcode.DEC: 1.2,
    Opcode.JMP: 1.5,
    Opcode.ALLOC: 5.0,
    Opcode.READ_HEAD: 2.0,
    Opcode.WRITE_HEAD: 2.5,
    Opcode.SHARE: 1.8,
}

#: Energy charged for landing on a byte that is not a valid opcode.
#: Deliberately steep so that a thread wandering through unstructured
#: noise burns out within a handful of cycles, while a well-formed genome
#: (which never contains illegal bytes by construction) never pays it.
ILLEGAL_OPCODE_COST: float = 6.0

#: A thread whose energy balance falls to or below this value is
#: considered metabolically exhausted and must be deallocated.
EXHAUSTION_THRESHOLD: float = 0.0


class VMError(Exception):
    """Base class for all virtual-machine execution errors."""


class IllegalOpcodeError(VMError):
    """Raised when the instruction pointer lands on a non-instruction byte."""

    def __init__(self, address: int, byte_value: int) -> None:
        self.address = address
        self.byte_value = byte_value
        super().__init__(
            f"illegal opcode 0x{byte_value:02X} at address {address}"
        )


class EnergyExhaustionError(VMError):
    """Raised when a thread's energy balance can no longer sustain execution."""

    def __init__(self, thread_id: int, energy: float) -> None:
        self.thread_id = thread_id
        self.energy = energy
        super().__init__(
            f"thread {thread_id} exhausted (energy={energy:.3f})"
        )


@runtime_checkable
class Substrate(Protocol):
    """The physical world a :class:`Thread` executes against.

    ``core.environment.Environment`` is the concrete implementation; this
    protocol exists purely so ``core/vm.py`` never imports it, keeping the
    instruction semantics unit-testable with a trivial fake substrate.
    """

    def read_byte(self, address: int) -> int:
        """Return the raw byte resident at an absolute memory address."""

    def write_byte(self, address: int, value: int, thread: "Thread") -> bool:
        """Attempt to write ``value`` at ``address`` on behalf of ``thread``.

        Returns ``True`` if the write was committed, ``False`` if it lost a
        collision-priority contest against a higher-energy resident thread.
        """

    def request_allocation(self, thread: "Thread") -> Optional[int]:
        """Ask the substrate for a free buffer adjacent to ``thread``'s
        genome, sized to ``thread.genome_length``. Returns the absolute
        start address of the new buffer, or ``None`` if none is available.
        """

    def harvest_energy(self, address: int, amount: float) -> float:
        """Draw up to ``amount`` of local potential energy at ``address``.
        Returns the amount actually harvested (may be less than requested).
        """

    def finalize_offspring(self, parent: "Thread") -> None:
        """Called once a parent's offspring buffer has been fully written,
        to spawn the child as a new living thread in the substrate.
        """


@dataclass
class Thread:
    """A single active instruction-tape execution context.

    Each ``Thread`` is one digital organism's CPU state: where it is
    executing (``ip``), where it is currently reading from its own genome
    (``read_head``), where it is currently writing into a claimed offspring
    buffer (``write_head``), and its two general-purpose registers.
    """

    thread_id: int
    genome_start: int
    genome_length: int
    ip: int = 0
    read_head: int = 0
    write_head: int = 0
    reg_a: int = 0
    reg_b: int = 0
    energy: float = 0.0
    generation: int = 0
    lineage_id: int = 0
    parent_id: Optional[int] = None
    strain: str = "seed"  # "seed" or "noise" — provenance of the founding ancestor
    offspring_start: Optional[int] = None
    offspring_length: int = 0
    offspring_progress: int = 0
    age_cycles: int = 0
    alive: bool = True

    def absolute_ip(self) -> int:
        """The IP expressed as an absolute address in global memory."""
        return self.genome_start + (self.ip % self.genome_length)

    def absolute_read_head(self) -> int:
        """The read head expressed as an absolute address in global memory."""
        return self.genome_start + (self.read_head % self.genome_length)

    def absolute_write_head(self) -> int:
        """The write head expressed as an absolute address in the
        currently-claimed offspring buffer. Raises if no buffer is claimed.
        """
        if self.offspring_start is None or self.offspring_length == 0:
            raise VMError(f"thread {self.thread_id} has no offspring buffer to write into")
        return self.offspring_start + (self.write_head % self.offspring_length)

    def active_register_name(self, address: int) -> str:
        """Which register a given address operates on, per design decision #1."""
        return "reg_a" if address % 2 == 0 else "reg_b"

    def get_active_register(self, address: int) -> int:
        return self.reg_a if self.active_register_name(address) == "reg_a" else self.reg_b

    def set_active_register(self, address: int, value: int) -> None:
        value &= 0xFF
        if self.active_register_name(address) == "reg_a":
            self.reg_a = value
        else:
            self.reg_b = value


@dataclass
class ExecutionResult:
    """Outcome of a single :meth:`CPUCore.execute` call, used by the
    environment/metrics layers without needing to inspect thread internals.
    """

    thread_id: int
    opcode: Optional[Opcode]
    energy_cost: float
    illegal: bool = False
    replicated: bool = False
    jumped: bool = False
    died: bool = False
    note: str = ""


class CPUCore:
    """Stateless executor: applies exactly one instruction to one
    :class:`Thread` against a :class:`Substrate`, per global clock cycle.
    """

    def execute(self, thread: Thread, substrate: Substrate) -> ExecutionResult:
        """Execute the single instruction at ``thread.ip`` and advance state.

        Energy is harvested from the thread's current execution coordinate
        before the instruction's cost is charged, modeling organisms that
        must draw potential energy from where their code physically sits.
        """
        if not thread.alive:
            raise VMError(f"cannot execute a dead thread ({thread.thread_id})")

        thread.age_cycles += 1
        address = thread.absolute_ip()
        raw_byte = substrate.read_byte(address) & 0xFF

        try:
            opcode = Opcode(raw_byte)
        except ValueError:
            harvested = substrate.harvest_energy(address, ILLEGAL_OPCODE_COST)
            thread.energy += harvested
            thread.energy -= ILLEGAL_OPCODE_COST
            thread.ip = (thread.ip + 1) % thread.genome_length
            if thread.energy <= EXHAUSTION_THRESHOLD:
                thread.alive = False
                return ExecutionResult(
                    thread.thread_id, None, ILLEGAL_OPCODE_COST, illegal=True, died=True,
                    note=f"illegal opcode 0x{raw_byte:02X} exhausted thread",
                )
            return ExecutionResult(thread.thread_id, None, ILLEGAL_OPCODE_COST, illegal=True)

        cost = INSTRUCTION_COSTS[opcode]
        harvested = substrate.harvest_energy(address, cost)
        thread.energy += harvested
        thread.energy -= cost

        result = ExecutionResult(thread.thread_id, opcode, cost)
        advance_ip = True

        if thread.energy <= EXHAUSTION_THRESHOLD:
            thread.alive = False
            result.died = True
            return result

        if opcode is Opcode.NOP:
            pass

        elif opcode is Opcode.INC:
            current = thread.get_active_register(address)
            thread.set_active_register(address, current + 1)

        elif opcode is Opcode.DEC:
            current = thread.get_active_register(address)
            thread.set_active_register(address, current - 1)

        elif opcode is Opcode.JMP:
            template_addr = thread.genome_start + ((thread.ip + 1) % thread.genome_length)
            template = substrate.read_byte(template_addr) & 0xFF
            target_complement = (~template) & 0xFF
            match_offset = self._find_template_match(
                thread, substrate, start_offset=thread.ip + 2, complement=target_complement,
            )
            if match_offset is not None:
                thread.ip = match_offset % thread.genome_length
                advance_ip = False
                result.jumped = True
            else:
                thread.ip = (thread.ip + 2) % thread.genome_length
                advance_ip = False

        elif opcode is Opcode.ALLOC:
            start = substrate.request_allocation(thread)
            if start is not None:
                thread.offspring_start = start
                thread.offspring_length = thread.genome_length
                thread.offspring_progress = 0
                thread.write_head = 0

        elif opcode is Opcode.READ_HEAD:
            byte_value = substrate.read_byte(thread.absolute_read_head())
            thread.set_active_register(address, byte_value)
            thread.read_head = (thread.read_head + 1) % thread.genome_length

        elif opcode is Opcode.WRITE_HEAD:
            if thread.offspring_start is not None:
                value = thread.get_active_register(address)
                committed = substrate.write_byte(thread.absolute_write_head(), value, thread)
                if committed:
                    thread.write_head = (thread.write_head + 1) % thread.offspring_length
                    thread.offspring_progress = min(
                        thread.offspring_length, thread.offspring_progress + 1
                    )
                    if thread.offspring_progress >= thread.offspring_length:
                        substrate.finalize_offspring(thread)
                        result.replicated = True
                        thread.offspring_start = None
                        thread.offspring_length = 0
                        thread.offspring_progress = 0

        elif opcode is Opcode.SHARE:
            share_amount = min(thread.energy * 0.1, 2.0)
            neighbor_address = address + 1
            thread.energy -= share_amount
            substrate.harvest_energy(neighbor_address, -share_amount)

        if advance_ip:
            thread.ip = (thread.ip + 1) % thread.genome_length

        if thread.energy <= EXHAUSTION_THRESHOLD:
            thread.alive = False
            result.died = True

        return result

    @staticmethod
    def _find_template_match(
        thread: Thread, substrate: Substrate, start_offset: int, complement: int
    ) -> Optional[int]:
        """Scan the organism's own circular genome for ``complement``,
        starting just past the JMP operand, wrapping at most one full
        revolution. Returns the absolute offset *after* the matching byte,
        or ``None`` if the genome contains no such byte.
        """
        length = thread.genome_length
        for step in range(length):
            offset = (start_offset + step) % length
            candidate = substrate.read_byte(thread.genome_start + offset)
            if (candidate & 0xFF) == complement:
                return offset + 1
        return None
