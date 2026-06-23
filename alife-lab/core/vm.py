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
   To keep the original 8-opcode ISA closed (no extra register-select
   instruction invented), the active register is a pure function of the
   instruction's own address:
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
4. **Illegal opcodes.** Only byte values defined as :class:`Opcode` members
   are valid instructions — originally ``0x00``-``0x07``, now also
   ``0x08``-``0x09`` (:data:`Opcode.SENSE_RESOURCE`/:data:`Opcode.IO_OUT`,
   added for richer evolution; see design decision #6). A genome (or noise
   region) byte outside the defined set is an illegal opcode: it costs
   :data:`ILLEGAL_OPCODE_COST` energy and raises no exception that halts
   the simulation — the calling environment is expected to catch
   :class:`IllegalOpcodeError`, charge the thread, and let energy
   exhaustion (not a hard crash) be the cause of death. This keeps the
   246/256 non-instruction byte values (still 96% of the alphabet)
   scientifically honest: spontaneous order arising from raw noise is
   *possible* but, as in reality, vanishingly rare and self-terminating.
5. **ALLOC is re-entrant, not one-shot.** Calling ALLOC while a previous
   offspring buffer is still being written is a no-op (the existing
   buffer is left alone) rather than clobbering it or erroring, and is
   priced at :data:`ALLOC_RETRY_COST` instead of the full allocation cost.
   This lets a genome safely place ALLOC *inside* its own copy loop (call
   it every iteration) so the organism opens a fresh offspring buffer
   again the moment its current one finalizes, and keeps doing so for as
   long as it lives — real colony growth from a single persistent parent,
   rather than each organism only ever getting one offspring in its entire
   life.
6. **Sensing and tasks give organisms something to act on besides raw
   copy speed.** :data:`Opcode.SENSE_RESOURCE` reads a quantized local
   resource reading into the active register at no energy cost (a pure
   probe — sensing the world shouldn't itself be metabolically punishing)
   and records it on :attr:`Thread.recent_inputs`, a 2-entry rolling
   window. :data:`Opcode.IO_OUT` "outputs" the active register's current
   value and checks it against :data:`TASKS`, a tiny fixed set of
   Avida-style Boolean logic functions of the two most recently sensed
   bytes; the first time a thread's output happens to match a given
   task's expected value, that task is recorded on
   :attr:`Thread.tasks_completed` (each task pays out at most once per
   thread) and reported via :attr:`ExecutionResult.tasks_completed` for
   the environment layer to reward — see ``core/environment.py``'s
   task-bonus design note. Task *semantics* (what counts as a match) live
   here in the substrate-agnostic CPU; task *rewards* (how much energy,
   and how it's paid out) are an environment-physics concern and
   deliberately live one layer up, mirroring the existing mutation-lives-
   in-the-environment split.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, runtime_checkable


class Opcode(enum.IntEnum):
    """The complete, closed 10-instruction ISA. Values outside this defined
    set (0x0A-0xFF) are not instructions and are illegal opcodes by design."""

    NOP = 0x00
    INC = 0x01
    DEC = 0x02
    JMP = 0x03
    ALLOC = 0x04
    READ_HEAD = 0x05
    WRITE_HEAD = 0x06
    SHARE = 0x07
    SENSE_RESOURCE = 0x08
    IO_OUT = 0x09


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
    # SENSE_RESOURCE is a pure probe: sensing the world shouldn't itself be
    # metabolically punishing, so it is the only opcode priced at zero.
    Opcode.SENSE_RESOURCE: 0.0,
    Opcode.IO_OUT: 1.3,
}

#: A tiny fixed set of Avida-style Boolean logic tasks, each a pure
#: function of the two most recently SENSE_RESOURCE'd bytes (older, newer).
#: IO_OUT checks its output against every task a thread hasn't already
#: completed; a match is what the environment layer rewards. Kept
#: deliberately small (matching classic Avida's easiest tasks) since the
#: point is to give evolution *something* to discover, not to hand-design
#: a curriculum.
TASKS: dict[str, Callable[[int, int], int]] = {
    "not": lambda older, newer: (~newer) & 0xFF,
    "and": lambda older, newer: older & newer,
    "nand": lambda older, newer: (~(older & newer)) & 0xFF,
}

#: Energy charged for landing on a byte that is not a valid opcode.
#: Deliberately steep so that a thread wandering through unstructured
#: noise burns out within a handful of cycles, while a well-formed genome
#: (which never contains illegal bytes by construction) never pays it.
ILLEGAL_OPCODE_COST: float = 6.0

#: Energy charged for an ALLOC executed while a previous offspring buffer
#: is still being written. Re-running ALLOC every loop iteration (so a
#: genome can sit it inside its own copy loop and keep reproducing for as
#: long as it lives) must not re-pay the full allocation cost on every one
#: of those iterations — only the iteration that actually opens a new
#: buffer should. This is priced the same as NOP, since that's all an
#: in-progress-buffer ALLOC actually does.
ALLOC_RETRY_COST: float = INSTRUCTION_COSTS[Opcode.NOP]

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

    def sense_resource(self, address: int) -> int:
        """Return a 0-255 quantized reading of local resource density at
        ``address``, for SENSE_RESOURCE. A pure probe: must not mutate
        any state (unlike :meth:`harvest_energy`, which is destructive).
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
    #: rolling window of the last 2 SENSE_RESOURCE readings (older, newer),
    #: the raw material IO_OUT checks against TASKS.
    recent_inputs: list[int] = field(default_factory=list)
    #: names of TASKS this thread has already been rewarded for; each task
    #: pays out at most once per thread (see IO_OUT's handling below).
    tasks_completed: set[str] = field(default_factory=set)

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
    #: names of TASKS newly completed by this instruction (usually empty;
    #: only ever populated by an IO_OUT that matched something new). The
    #: environment layer is responsible for turning this into an energy
    #: reward — see core/environment.py's task-bonus design note.
    tasks_completed: list[str] = field(default_factory=list)


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

        alloc_already_in_progress = opcode is Opcode.ALLOC and thread.offspring_start is not None
        cost = ALLOC_RETRY_COST if alloc_already_in_progress else INSTRUCTION_COSTS[opcode]
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
            if not alloc_already_in_progress:
                start = substrate.request_allocation(thread)
                if start is not None:
                    thread.offspring_start = start
                    thread.offspring_length = thread.genome_length
                    thread.offspring_progress = 0
                    thread.write_head = 0
            # else: a buffer is already open from a previous pass through
            # this same ALLOC — this pass is a no-op, see ALLOC_RETRY_COST.

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

        elif opcode is Opcode.SENSE_RESOURCE:
            sensed = substrate.sense_resource(address) & 0xFF
            thread.set_active_register(address, sensed)
            thread.recent_inputs.append(sensed)
            del thread.recent_inputs[:-2]

        elif opcode is Opcode.IO_OUT:
            output = thread.get_active_register(address)
            if len(thread.recent_inputs) == 2:
                older, newer = thread.recent_inputs
                for task_name, task_fn in TASKS.items():
                    if task_name in thread.tasks_completed:
                        continue
                    if task_fn(older, newer) == output:
                        thread.tasks_completed.add(task_name)
                        result.tasks_completed.append(task_name)

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
