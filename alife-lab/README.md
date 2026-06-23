# alife-lab — Artificial Life Simulation & Digital Evolution Laboratory

A scientific tracking engine and behavioral laboratory for studying
computational autopoiesis, emergent self-replication, and open-ended
evolution on a synthetic CPU substrate, in the lineage of Tierra / Avida.

**This is not a game.** There is no player, no win condition, and no
score. It is a closed system you seed with a hand-crafted self-replicator
and a sea of raw noise, then observe — headless at maximum throughput, or
through a live read-only spectrogram — as digital organisms compete for
finite thermodynamic energy, mutate, speciate, and occasionally arise
from nothing at all.

It is written in standalone Python (not browser JS) because its subject —
a CPU-level virtual machine substrate with thermodynamic physics and a
real-time Pygame instrumentation layer — has no meaningful browser
analogue. Run it from a terminal with `python main.py`; it has no
`index.html` and is not wired into this repository's game portal.

## Why it exists

Real abiogenesis and evolution are unobservable at the timescales and
resolutions a single researcher has access to. This lab compresses both
into something you can watch: a flat byte array is the entire universe, a
24-byte program is the entire genome, and one CPU instruction is the
entire unit of metabolic time. Every emergent phenomenon — replication,
parasitism, speciation, extinction, spontaneous order arising from pure
noise — has to fall out of four small, fully-specified rules:

1. An 8-instruction CPU (`core/vm.py`).
2. A thermodynamic energy economy that is the *only* currency for staying
   alive or reproducing (`core/environment.py`).
3. A single hand-seeded ancestor genome, dropped into one half of a
   universe that is otherwise uniform random noise (`core/initializer.py`).
4. Continuous, real-time measurement, so claims about what happened are
   never anecdotal (`analytics/metrics.py`, `viz/dashboard.py`).

## Architecture

```
alife-lab/
├── core/
│   ├── vm.py            CPU substrate: ISA, Thread state, CPUCore.execute()
│   ├── environment.py    Concrete Substrate: memory lattice, energy field,
│   │                     collision arbitration, organism lifecycle
│   └── initializer.py    Hybrid Primordial Matrix: config loading, Ancestor
│                         genome construction, noise/seed sector seeding
├── analytics/
│   └── metrics.py        Shannon entropy, Kolmogorov complexity proxy,
│                         PhylogeneticTracer (lineages, speciation, takeovers)
├── viz/
│   └── dashboard.py      Read-only Pygame spectrogram + sidebar telemetry
├── config/
│   └── default.yaml      Tuned default physical constants
├── tests/                pytest suite, one file per module above
├── main.py                CLI entry point: headless benchmark or dashboard
└── requirements.txt
```

Dependency direction is strictly one-way:
`vm.py` → `environment.py` → `initializer.py` / `metrics.py` → `dashboard.py` / `main.py`.
`core/vm.py` never imports `core/environment.py` — it depends only on the
`Substrate` `Protocol` it declares, so the CPU's instruction semantics are
unit-testable with a trivial fake substrate, completely independent of
the real world's physics.

### `core/vm.py` — the CPU substrate

An 8-bit, 8-instruction closed ISA. Byte values `0x08`-`0xFF` are not
instructions; landing on one is an *illegal opcode*, not a crash — it
costs steep energy and is exactly how noise-derived "organisms" usually
die within a few cycles.

| Opcode | Value | Energy cost | Effect |
|---|---|---|---|
| `NOP` | `0x00` | 1.0 | No-op; doubles as a JMP landing-pad label |
| `INC` | `0x01` | 1.2 | Increment the active register |
| `DEC` | `0x02` | 1.2 | Decrement the active register |
| `JMP` | `0x03` | 1.5 | Template-match jump (see below) |
| `ALLOC` | `0x04` | 5.0 | Request an offspring buffer from the substrate |
| `READ_HEAD` | `0x05` | 2.0 | Read genome byte at read-head into active register, advance read-head |
| `WRITE_HEAD` | `0x06` | 2.5 | Write active register to offspring buffer at write-head, advance write-head |
| `SHARE` | `0x07` | 1.8 | Donate up to 10% of own energy (max 2.0) to the next address |

Four ambiguities in the original ISA spec were resolved as explicit,
documented design decisions (full rationale in `core/vm.py`'s module
docstring):

1. **Active register selection.** No dedicated register-select opcode
   exists, so the active register for `INC`/`DEC`/`READ_HEAD`/`WRITE_HEAD`
   is a pure function of the *instruction's own address*: even addresses
   touch `RegA`, odd addresses touch `RegB`. A genome's layout implicitly
   chooses its own register usage.
2. **Head auto-advance.** `READ_HEAD`/`WRITE_HEAD` each advance their own
   head pointer after every access, satisfying the Ancestor genome's
   "INC pointers" step without a separate opcode.
3. **JMP template matching.** A one-byte simplification of Tierra's
   multi-NOP template matching: `JMP`'s operand byte is complemented, and
   execution searches the organism's own circular genome for the first
   byte equal to that complement, landing just past it. `0xFF` finds the
   nearest `0x00` (`NOP`) — giving NOP a second life as a loop label.
4. **Illegal opcodes don't halt the simulation.** They cost
   `ILLEGAL_OPCODE_COST` (6.0) energy and let exhaustion — not an
   exception — be the actual cause of death, keeping noise-derived order
   scientifically honest: rare, and self-terminating when it fails.

Every instruction harvests local ambient energy from the substrate
*before* its cost is charged — see `core/environment.py` for where that
energy actually comes from.

### `core/environment.py` — thermodynamic resource physics

The concrete `Substrate`: a toroidal (wraparound) flat memory lattice with
a parallel continuous resource-diffusion grid. There is no "food item"
anywhere — energy is a scalar field over the same coordinate space as the
genomes themselves.

- **Diffusion.** Each cycle, every cell's resource value blends toward its
  4-neighbor average (`diffusion_rate`) and regenerates toward
  `baseline_resource` (`regen_rate`), capped at `max_resource`.
- **Collision arbitration.** When two threads' writes target the same
  coordinate, the *higher-energy* resident wins; the loser's write is
  silently rejected. All mutation of the shared `memory`/`owner` arrays
  happens under a single lock, so the (currently single-threaded)
  round-robin scheduler can later move onto a real thread/process pool
  without touching this module.
- **Allocation locality.** `request_allocation` tries the two cells
  immediately touching the parent's own genome first, then a bounded
  neighborhood out to `local_search_radius` genome-lengths on each side
  (nearest free slot wins), and only falls back to a uniformly random free
  position anywhere in the universe if nothing is free nearby. Without the
  middle tier, a colony gets exactly one generation of adjacent growth
  before every later offspring is scattered across the map — starving
  every lineage of the chance to ever hold contiguous territory.
- **Copy-fidelity mutation.** Every committed write has an independent
  chance (`mutation_rate`) of landing as a random byte instead — the sole
  source of genetic novelty in the lab.
- **Spontaneous abiogenesis probes.** Raw noise is otherwise completely
  inert. Each cycle, a small number of independent "probe" threads
  (`probe_spawn_count`) open at random *unclaimed* coordinates and start
  interpreting whatever bytes are already there as a genome — the only
  mechanism by which the Pure Noise Sector has any chance, however small,
  of producing a self-sustaining replicator.
- **Deallocation.** A thread that dies (energy exhaustion or terminal
  illegal-opcode cost) has its claimed memory overwritten with fresh
  random bytes and returned to the unclaimed pool — exactly like raw
  background noise, because at that point it *is* raw background noise
  again.

### `core/initializer.py` — the Hybrid Primordial Matrix

Builds the very first state of the universe from a YAML/JSON config file:
the entire lattice starts as uniform random bytes (`0x00`-`0xFF`), and the
back `1 - noise_fraction` of it (the *Seeded Sector*) additionally
receives `seed_instances` evenly-spaced copies of the canonical 24-byte
**Ancestor** genome:

```
ALLOC, NOP, READ_HEAD, WRITE_HEAD, JMP, 0xFF, INC × 18
       ^loop label                  ^template (complement 0x00 = the NOP above)
```

`ALLOC` runs exactly once per organism, outside the loop, exactly as
specified — every offspring is a full genome copy that starts its own
execution at its own `ALLOC`, so the *lineage* keeps reproducing across
generations even though no single individual ever allocates twice. The 18
trailing bytes are `INC`, never `NOP`, specifically so they can't
accidentally satisfy the loop's own jump template before genuinely
wrapping around to the real label.

### `analytics/metrics.py` — phylogenetics & information theory

- `shannon_entropy(memory)` — bits/byte over the full 256-symbol alphabet;
  starts at (or near) 8.0 on a freshly-randomized lattice and falls
  measurably as replicators impose order on chaos.
- `kolmogorov_complexity_approx(genome)` — DEFLATE-compressed length, the
  standard computable proxy for the uncomputable true quantity. A minimal
  self-replicator's long `INC`/`NOP` padding compresses far smaller than
  true noise of the same length.
- `PhylogeneticTracer` — wired onto `Environment`'s `on_birth`/`on_death`/
  `on_overwrite` hooks. Builds a live ancestry tree (`LineageRecord` per
  lineage), forks a child onto a fresh lineage id whenever its genome's
  Hamming distance from its parent exceeds `divergence_threshold`
  (`SpeciationEvent`), and tallies cross-strain takeovers
  (`OverwriteEvent`, queryable as `noise_defeats_seed_count()` /
  `seed_defeats_noise_count()`).
- `take_snapshot(environment, tracer)` — the single `MetricsSnapshot`
  consumed by both the headless reporter and the dashboard sidebar.

### `viz/dashboard.py` — the spectrogram dashboard

A strictly read-only Pygame window. It never calls `Environment.step()`
and never mutates simulation state — it is handed the same live
`Environment`/`PhylogeneticTracer` objects an independently-clocked
simulation loop is advancing, and only ever *samples* them once per
render tick, by design (see the module's docstring on the
sampling tradeoff this implies).

Per frame: build an RGB image straight from `Environment.strain` (Cold
Cyan = seed descendants, High-Energy Amber = noise strains, Dark Slate =
unallocated), blend in a phosphor-burn layer that flashes white-hot on
every coordinate any thread's instruction pointer touched since the last
frame and decays exponentially (`phosphor_decay`) thereafter, upscale by
`cell_size`, and draw a sidebar readout of cycle, active threads,
generation delta, Shannon entropy, births/deaths, speciation events,
cross-strain takeovers, and per-lineage population share.

### `main.py` — the Lab Executive Controller

```
python main.py --mode headless  --config config/default.yaml --cycles 0 --report-interval 500
python main.py --mode dashboard --config config/default.yaml --cycles 0
```

`--mode headless` never imports Pygame at all and runs at maximum
throughput, printing a metrics line every `--report-interval` cycles.
`--mode dashboard` advances the simulation on an independent background
thread while the Pygame window renders on the main thread at its own pace
— the two share the `Environment`/`PhylogeneticTracer` instances but
never block on each other. `--cycles 0` (the default) runs until
interrupted (Ctrl+C in headless mode, window close / Esc in dashboard
mode).

`build_traced_environment()` constructs the `Environment` via
`core.initializer.build_environment()` — which has already seeded the
founding Ancestors by the time it returns — then attaches a fresh
`PhylogeneticTracer` to its lifecycle hooks and *replays* those
already-spawned founders into the tracer. (Threading tracer callbacks
through `build_environment()`'s own constructor call was considered and
rejected: the Ancestors are seeded from inside that function, before it
returns, so any caller-side closure that captures its own not-yet-assigned
`Environment` reference would raise on the very first founding birth.
Wiring hooks after construction and replaying once has no such hazard.)

## Configuration

Runtime physics live in `config/default.yaml` (or any YAML/JSON file
passed via `--config`):

| Key | Default | Meaning |
|---|---|---|
| `width`, `height` | 256, 256 | Lattice dimensions (toroidal) |
| `baseline_resource` | 6.0 | Steady-state energy density per cell |
| `max_resource` | 40.0 | Cap on harvestable energy per cell |
| `diffusion_rate` | 0.15 | Per-cycle blend toward 4-neighbor average |
| `regen_rate` | 0.02 | Per-cycle pull back toward `baseline_resource` |
| `initial_energy` | 400.0 | Starting energy for a freshly-spawned organism |
| `offspring_energy_share` | 0.5 | Fraction of parent's remaining energy handed to a new offspring |
| `mutation_rate` | 0.0025 | Per-write chance of corruption to a random byte |
| `probe_spawn_count` | 4 | Spontaneous-abiogenesis probe threads opened per cycle |
| `probe_genome_length` | 24 | Genome length interpreted by each probe |
| `local_search_radius` | 12 | Genome-lengths searched on each side of a parent for a free slot before falling back to a random one anywhere |
| `noise_fraction` | 0.5 | Fraction of the lattice that is the Pure Noise Sector |
| `seed_instances` | 24 | Number of Ancestor copies seeded into the Seeded Sector |
| `random_seed` | 1729 | RNG seed, for reproducible runs |

## Running the tests

```
pip install -r requirements.txt
python -m pytest tests/ -q
```

Tests are organized one file per module (`test_vm.py`, `test_environment.py`,
`test_metrics.py`, `test_main.py`) plus a slower end-to-end integration test
confirming a single seeded Ancestor reliably replicates within a bounded
number of cycles under tuned defaults.
