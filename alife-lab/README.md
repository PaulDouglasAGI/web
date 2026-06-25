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
│   ├── initializer.py    Hybrid Primordial Matrix: config loading, Ancestor
│   │                     genome construction, noise/seed sector seeding
│   └── persistence.py    Checkpoint save/load (Environment + tracer state)
├── analytics/
│   ├── metrics.py        Shannon entropy, Kolmogorov complexity proxy,
│   │                     PhylogeneticTracer (lineages, speciation, takeovers)
│   └── export.py         Incrementally-appending CSV metrics writer
├── viz/
│   ├── dashboard.py      Read-only Pygame spectrogram + sidebar telemetry
│   └── server.py         Stdlib HTTP server streaming the same view as MJPEG
├── config/
│   └── default.yaml      Tuned default physical constants
├── tests/                pytest suite, one file per module above
├── main.py                CLI entry point: headless / dashboard / dashboard-server
└── requirements.txt
```

Dependency direction is strictly one-way:
`vm.py` → `environment.py` → `initializer.py` / `metrics.py` → `dashboard.py` / `main.py`.
`core/vm.py` never imports `core/environment.py` — it depends only on the
`Substrate` `Protocol` it declares, so the CPU's instruction semantics are
unit-testable with a trivial fake substrate, completely independent of
the real world's physics.

### `core/vm.py` — the CPU substrate

An 8-bit, 10-instruction closed ISA. Byte values `0x0A`-`0xFF` are not
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
| `SENSE_RESOURCE` | `0x08` | 0.0 | Read local resource density (quantized 0-255) into the active register — a free, non-mutating probe |
| `IO_OUT` | `0x09` | 1.3 | Output the active register; reward a newly-matched Boolean task on the last two sensed readings (see below) |

Six ambiguities in the original ISA spec were resolved as explicit,
documented design decisions (full rationale in `core/vm.py`'s module
docstring):

1. **Active register selection.** No dedicated register-select opcode
   exists, so the active register for `INC`/`DEC`/`READ_HEAD`/`WRITE_HEAD`
   is a pure function of the *instruction's own address*: even addresses
   touch `RegA`, odd addresses touch `RegB`. A genome's layout implicitly
   chooses its own register usage — which means `READ_HEAD` and
   `WRITE_HEAD` must sit at *matching* address parity (an even number of
   bytes apart) or `WRITE_HEAD` will always read a register `READ_HEAD`
   never populated, silently copying zeros forever. The Ancestor genome
   below is laid out with this constraint in mind.
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
5. **ALLOC is re-entrant.** Calling `ALLOC` while a previous offspring
   buffer is still being written is a cheap no-op (priced like `NOP`)
   rather than an error or a clobber, so a genome can safely call `ALLOC`
   on every pass through its own copy loop and keep reproducing for as
   long as it lives, instead of getting exactly one offspring per lifetime.
6. **Sensing/output is split into mechanics vs. reward.** `SENSE_RESOURCE`
   records each reading onto a 2-entry rolling window
   (`Thread.recent_inputs`); `IO_OUT` checks its output against a small
   fixed set of Boolean functions of that window (`core/vm.py`'s `TASKS`:
   `not`, `and`, `nand`) and reports any newly-matched task name, but it is
   `core/environment.py`'s `_award_task_bonus` that decides what a match is
   *worth* — the same vm.py-decides-what / environment.py-decides-how-much
   split the energy economy already uses elsewhere. Each task pays out at
   most once per thread (`Thread.tasks_completed`), so this rewards
   *discovering* a computation, not repeating one.

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
  (nearest free slot wins), then a handful of randomly-positioned windows,
  and only falls back to an exhaustive scan of the whole lattice if every
  one of those misses. Without the middle tier, a colony gets exactly one
  generation of adjacent growth before every later offspring is scattered
  across the map — starving every lineage of the chance to ever hold
  contiguous territory.
- **"No room" caching.** At steady-state population the universe routinely
  has free *cells* in aggregate but no contiguous free *run* as long as a
  genome anywhere — external fragmentation, the same pathology a heap
  allocator can suffer from — so every search tier above is doomed to fail
  honestly on every `ALLOC` call. `Environment._no_room_for_length` records
  the smallest length the last exhaustive scan confirmed has no free run,
  letting later calls for that length (or longer) skip straight to failure
  instead of re-paying for the full search; it's cleared the instant any
  organism dies, since freeing memory can only make a free run longer.
- **Occupancy ceiling.** Diagnosing a long-run collapse traced it to exactly
  the fragmentation pathology described above: occupancy climbs to ~90% of
  the lattice almost immediately and stays there, at which point free cells
  exist but are fragmented into runs shorter than a genome nearly
  everywhere, so `ALLOC` failure rates run into the millions per few
  thousand cycles. The population then sits one mutation away from a
  runaway death cascade — a death frees a slot, the resulting birth burst
  is ~5-6% fatally mutated, and those deaths free more slots. `request_allocation`
  now refuses all new allocations once occupancy reaches `max_occupancy_fraction`
  of the lattice, regardless of how much free space remains, keeping enough
  slack that genome-length free runs stay findable and the gridlock never
  forms. Tracked via an O(1) `Environment._occupied_cells` counter (the
  ceiling check runs on every `ALLOC` call, far too often for an
  `(owner != -1).sum()` rescan) incremented at every claim site and
  decremented in `_free_region`.
- **Copy-fidelity mutation.** Every committed write has an independent
  chance (`mutation_rate`) of landing as a random byte instead — the sole
  source of genetic novelty in the lab.
- **Spontaneous abiogenesis probes.** Raw noise is otherwise completely
  inert. Each cycle, a small number of independent "probe" threads
  (`probe_spawn_count`) open at random *unclaimed* coordinates and start
  interpreting whatever bytes are already there as a genome — the only
  mechanism by which the Pure Noise Sector has any chance, however small,
  of producing a self-sustaining replicator.
- **Senescence.** A population that fully occupies every contiguous run
  the lattice can offer reaches a state where nobody has room to
  reproduce *and* every survivor's harvested energy exactly offsets its
  spend, so nobody dies either — turnover (and all further mutation and
  speciation) halts completely. `senescence_rate` deducts a small fixed
  energy amount from every living thread each cycle, independent of
  whatever instruction it executed, so energy balance is never a stable
  equilibrium and territory keeps recycling indefinitely.
- **Task bonuses.** A matching `IO_OUT` (design decision #6 above) pays
  `task_bonus_energy` into the resource field at the rewarded thread's own
  current address, via the same negative-amount `harvest_energy` deposit
  convention `SHARE` already uses — so the reward stays inside the single
  thermodynamic field model instead of becoming a second, parallel
  currency, and the thread (or a neighbor) has to harvest it the ordinary
  way on a later instruction.
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
NOP, ALLOC, READ_HEAD, INC, WRITE_HEAD, JMP, 0xFF, INC × 17
^loop label                                ^template (complement 0x00 = the NOP above)
```

`ALLOC` sits *inside* the loop — re-entrant `ALLOC` (design decision #5)
means each pass either opens a fresh offspring buffer the moment the
previous one finalizes, or quietly no-ops while one is still in progress,
so a single organism keeps reproducing for as long as it lives rather than
getting exactly one offspring in its entire lifetime. The single `INC`
between `READ_HEAD` and `WRITE_HEAD` is a parity spacer, not filler: it
keeps both instructions' addresses at matching parity (design decision #1)
so `WRITE_HEAD` always writes out the very byte `READ_HEAD` just read,
rather than an always-zero register it never touched. The 17 trailing
bytes are `INC`, never `NOP`, specifically so they can't accidentally
satisfy the loop's own jump template before genuinely wrapping around to
the real label.

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

### `viz/server.py` — the mobile/cloud live dashboard server

Streams the exact same lineage-color + phosphor-burn visualization as
`viz/dashboard.py`, over plain HTTP instead of a local Pygame window, so
any phone or browser can watch a running simulation live via a plain
`<img>` tag — no app, no Pygame on the client, and no new dependencies
beyond what `viz/dashboard.py` already needs.

Three independently-clocked threads share the same live
`Environment`/`PhylogeneticTracer` objects: the simulation thread (driven
by `main.py`, exactly as in `--mode dashboard`); `FrameProducer`, which
renders and JPEG-encodes one frame at `DashboardServerConfig.target_fps`
on its own thread, reusing `viz/dashboard.py`'s pure-numpy
`build_strain_color_image`/`apply_phosphor_overlay`/`PhosphorDecayLayer`
untouched (none of those ever touch Pygame's display/font subsystems —
only `Dashboard.__init__` does, and this module never imports `Dashboard`
at all); and `DashboardHTTPServer`, a stdlib `ThreadingHTTPServer` that
serves the single latest frame to every connected MJPEG viewer and
`/stats.json` poller, so N simultaneous viewers never re-render or
re-encode anything themselves.

JPEG encoding happens with `SDL_VIDEODRIVER=dummy` set (this module sets
the default itself), confirmed empirically to encode a `Surface` to JPEG
bytes with no real display ever opened — safe in any headless container.
`--mode headless` still never imports Pygame: `viz/server.py` is only
ever imported once `--mode dashboard-server` actually runs.

### `main.py` — the Lab Executive Controller

```
python main.py --mode headless  --config config/default.yaml --cycles 0 --report-interval 500
python main.py --mode dashboard --config config/default.yaml --cycles 0
python main.py --mode dashboard-server --host 0.0.0.0 --port 8000
python main.py --mode headless --cycles 50000 --checkpoint-out runs/save --metrics-csv runs/metrics.csv
python main.py --mode headless --resume-from runs/save --cycles 50000
```

`--mode headless` never imports Pygame at all and runs at maximum
throughput, printing a metrics line every `--report-interval` cycles.
`--mode dashboard` advances the simulation on an independent background
thread while the Pygame window renders on the main thread at its own pace
— the two share the `Environment`/`PhylogeneticTracer` instances but
never block on each other. `--mode dashboard-server` uses the same
decoupled background-thread simulation, but renders into an MJPEG stream
served by `viz/server.py` over `--host`/`--port` instead of a local
window — open `http://<host>:<port>/` in any browser to watch. `--cycles
0` (the default) runs until interrupted (Ctrl+C in headless/server mode,
window close / Esc in dashboard mode).

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

`--checkpoint-out PATH` saves a full checkpoint (via
`core/persistence.py`) once the run ends, whether by reaching `--cycles`
or by interruption; `--resume-from PATH` loads one instead of seeding a
fresh universe via `resume_traced_environment()` (the same
wire-hooks-after-construction pattern as `build_traced_environment()`,
minus the founder replay — a loaded tracer's lineage records already
reflect everything up to the save point). `--metrics-csv PATH` appends
one row per periodic report to a CSV file via `analytics/export.py`'s
`MetricsCSVWriter`, independent of either flag above.

### `core/persistence.py` — checkpoint / resume

`save_checkpoint(environment, tracer, path)` writes a single `.npz` file
containing the five numpy state arrays (`memory`, `owner`, `lineage`,
`strain`, `resource`) plus a JSON-encoded `meta` array holding everything
else needed to resume exactly: every live `Thread`, the RNG's own
bit-generator state, the `EnvironmentConfig`, and the tracer's
lineage/speciation/overwrite history. JSON rather than `pickle`, so
`np.load`'s safe default `allow_pickle=False` still works and the
non-array state stays plain-text-inspectable. Never serialized:
`on_birth`/`on_death`/`on_overwrite` (closures over a specific tracer
instance, meaningless across a save/load boundary) and the
allocation-search `_no_room_for_length` cache (cheap to re-derive, safer
left unset than trusted blindly after a restore). `load_checkpoint(path)`
reverses all of it; callers re-wire the lifecycle hooks afterward exactly
as `main.py`'s `resume_traced_environment()` does.

### `analytics/export.py` — CSV metrics export

`MetricsCSVWriter(path)` appends one row per `MetricsSnapshot` to a CSV
file, opening it in append mode on every write rather than holding a long
run's full snapshot history in memory. Writes the header once, on first
use against a fresh or empty file; resuming a run that points at an
already-populated CSV file correctly skips re-writing the header.

## Configuration

Runtime physics live in `config/default.yaml` (or any YAML/JSON file
passed via `--config`):

| Key | Default | Meaning |
|---|---|---|
| `width`, `height` | 256, 256 | Lattice dimensions (toroidal) |
| `baseline_resource` | 24.0 | Steady-state energy density per cell |
| `max_resource` | 120.0 | Cap on harvestable energy per cell |
| `diffusion_rate` | 0.15 | Per-cycle blend toward 4-neighbor average |
| `regen_rate` | 0.06 | Per-cycle pull back toward `baseline_resource` |
| `initial_energy` | 400.0 | Starting energy for a freshly-spawned organism |
| `offspring_energy_share` | 0.4 | Fraction of parent's remaining energy handed to a new offspring |
| `mutation_rate` | 0.0025 | Per-write chance of corruption to a random byte |
| `probe_spawn_count` | 4 | Spontaneous-abiogenesis probe threads opened per cycle |
| `probe_genome_length` | 24 | Genome length interpreted by each probe |
| `local_search_radius` | 12 | Genome-lengths searched on each side of a parent for a free slot before falling back to a random one anywhere |
| `senescence_rate` | 0.00005 | Flat per-cycle energy decay applied to every living thread, independent of instruction cost, guaranteeing eventual death (and territory turnover) even at perfect energy balance |
| `task_bonus_energy` | 15.0 | Energy deposited into the resource field on a newly-matched `IO_OUT` Boolean task (paid once per task per thread) |
| `max_occupancy_fraction` | 0.65 | Fraction of the lattice that may be claimed before `request_allocation` refuses all new allocations, preventing the fragmentation gridlock that otherwise forms near ~90% occupancy |
| `noise_fraction` | 0.5 | Fraction of the lattice that is the Pure Noise Sector |
| `seed_instances` | 16 | Number of Ancestor copies seeded into the Seeded Sector |
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
