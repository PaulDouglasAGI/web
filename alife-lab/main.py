"""main.py — Laboratory Executive Controller.

The single entry point for running the digital evolution lab, in any of
three mutually exclusive modes:

* ``--mode headless`` — run the simulation as fast as Python/numpy can
  manage, printing periodic textual metrics reports. ``viz/dashboard.py``
  (and therefore Pygame) is never imported in this mode, so the lab runs
  unmodified in any environment, including headless CI containers with no
  display server.
* ``--mode dashboard`` — open the read-only Pygame spectrogram window on
  the main thread while the simulation itself advances on an independent
  background thread, exactly as ``viz/dashboard.py``'s docstring requires:
  the dashboard never calls ``Environment.step()``, and the simulation
  never waits on the renderer. The two are coupled only by the shared,
  lock-protected ``Environment``/``PhylogeneticTracer`` objects.
* ``--mode dashboard-server --host --port`` — the same decoupled
  simulation-thread pattern as ``--mode dashboard``, but instead of a
  local Pygame window, a stdlib ``http.server`` (see ``viz/server.py``)
  streams the identical lineage-color + phosphor-burn visualization as
  MJPEG, so any phone or browser on the network can watch a run live with
  no app and no Pygame on the client.

All three modes share :func:`build_traced_environment`, which constructs the
Environment via ``core.initializer.build_environment`` and then attaches a
fresh :class:`~analytics.metrics.PhylogeneticTracer` to its lifecycle
hooks. Because the Ancestors are already seeded by the time
``build_environment`` returns, the founding births are replayed into the
tracer explicitly so the ancestry tree is complete from cycle zero —
see that function's docstring for why hooking the tracer in any earlier
(e.g. by threading callback parameters through ``build_environment``
itself) is not actually possible without a closure-ordering hazard.

``--resume-from PATH`` loads a prior ``--checkpoint-out`` save instead of
seeding a fresh universe (see :func:`resume_traced_environment` and
``core/persistence.py``); ``--checkpoint-out PATH`` saves one at the end
of the run. ``--metrics-csv PATH`` appends one row per periodic report to
a CSV file via ``analytics/export.py``, independent of either mode.
"""

from __future__ import annotations

import argparse
import threading
import time
from typing import List, Optional, Tuple

from analytics.export import MetricsCSVWriter
from analytics.metrics import PhylogeneticTracer, take_snapshot
from core.environment import Environment
from core.initializer import build_environment
from core.persistence import load_checkpoint, save_checkpoint


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="alife-lab",
        description="Artificial Life Simulation & Digital Evolution Laboratory",
    )
    parser.add_argument(
        "--mode",
        choices=["headless", "dashboard", "dashboard-server"],
        default="headless",
        help="run as a fast textual benchmark (default), open the read-only spectrogram dashboard, "
        "or serve a live MJPEG dashboard over HTTP for remote/mobile viewing",
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="dashboard-server mode only: address to bind the HTTP server to (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="dashboard-server mode only: port to bind the HTTP server to (default: 8000)",
    )
    parser.add_argument(
        "--config",
        default="config/default.yaml",
        help="path to a YAML or JSON runtime configuration file (default: config/default.yaml)",
    )
    parser.add_argument(
        "--cycles",
        type=int,
        default=0,
        help="number of global clock cycles to run; 0 means run until interrupted (Ctrl+C / window close)",
    )
    parser.add_argument(
        "--report-interval",
        type=int,
        default=500,
        help="headless mode only: print a metrics snapshot every N cycles (default: 500)",
    )
    parser.add_argument(
        "--resume-from",
        default=None,
        help="path to a checkpoint previously written by --checkpoint-out; resumes instead of seeding a fresh universe",
    )
    parser.add_argument(
        "--checkpoint-out",
        default=None,
        help="path to save a checkpoint to once the run ends (interrupted or cycle-limited)",
    )
    parser.add_argument(
        "--metrics-csv",
        default=None,
        help="headless mode only: append one CSV row per periodic report to this path",
    )
    return parser.parse_args(argv)


def build_traced_environment(config_path: str) -> Tuple[Environment, PhylogeneticTracer]:
    """Build the Environment, then attach a PhylogeneticTracer to its
    lifecycle hooks and replay the already-seeded founding Ancestors into
    it, so the ancestry tree is complete from cycle zero onward.
    """
    environment = build_environment(config_path=config_path)
    tracer = PhylogeneticTracer()
    environment.on_birth = lambda child, parent: tracer.on_birth(child, parent, environment)
    environment.on_death = tracer.on_death
    environment.on_overwrite = tracer.on_overwrite
    for founder in environment.threads.values():
        tracer.on_birth(founder, None, environment)
    return environment, tracer


def resume_traced_environment(checkpoint_path: str) -> Tuple[Environment, PhylogeneticTracer]:
    """Load a checkpoint written by :func:`core.persistence.save_checkpoint`
    and re-wire its tracer's lifecycle hooks onto the restored Environment.

    Unlike :func:`build_traced_environment`, founding births are never
    replayed here — the loaded tracer's lineage records already reflect
    every birth up to the moment the checkpoint was saved.
    """
    environment, tracer = load_checkpoint(checkpoint_path)
    environment.on_birth = lambda child, parent: tracer.on_birth(child, parent, environment)
    environment.on_death = tracer.on_death
    environment.on_overwrite = tracer.on_overwrite
    return environment, tracer


def run_headless(
    environment: Environment,
    tracer: PhylogeneticTracer,
    cycles: int,
    report_interval: int,
    metrics_writer: Optional[MetricsCSVWriter] = None,
) -> None:
    """Advance the simulation at full speed with no rendering at all,
    printing a metrics line every ``report_interval`` cycles. Runs forever
    if ``cycles`` is 0, until interrupted.
    """
    start_time = time.monotonic()
    cycle_count = 0
    already_reported_this_cycle = False
    try:
        while cycles <= 0 or cycle_count < cycles:
            tracer.set_cycle(environment.cycle)
            environment.step()
            cycle_count += 1
            already_reported_this_cycle = cycle_count % report_interval == 0
            if already_reported_this_cycle:
                _print_report(environment, tracer, start_time, metrics_writer)
    except KeyboardInterrupt:
        print("\ninterrupted")
        already_reported_this_cycle = False
    if not already_reported_this_cycle:
        _print_report(environment, tracer, start_time, metrics_writer)


def _print_report(
    environment: Environment,
    tracer: PhylogeneticTracer,
    start_time: float,
    metrics_writer: Optional[MetricsCSVWriter] = None,
) -> None:
    snapshot = take_snapshot(environment, tracer)
    elapsed = max(time.monotonic() - start_time, 1e-9)
    rate = snapshot.cycle / elapsed
    dominant = ", ".join(f"{lid}:{count}" for lid, count in snapshot.dominant_lineages[:3]) or "none"
    print(
        f"cycle={snapshot.cycle:>8} "
        f"rate={rate:8.1f} cyc/s "
        f"threads={snapshot.active_threads:>5} "
        f"entropy={snapshot.shannon_entropy:5.3f} "
        f"births={snapshot.total_births:>6} "
        f"deaths={snapshot.total_deaths:>6} "
        f"speciation={snapshot.speciation_count:>4} "
        f"noise>seed={snapshot.noise_defeats_seed:>4} "
        f"seed>noise={snapshot.seed_defeats_noise:>4} "
        f"dominant=[{dominant}]"
    )
    if metrics_writer is not None:
        metrics_writer.write(snapshot)


def run_dashboard(environment: Environment, tracer: PhylogeneticTracer, cycles: int) -> None:
    """Run the simulation on a background thread while the Pygame
    spectrogram dashboard renders on the main thread, fully decoupled from
    each other's clock rates.
    """
    from viz.dashboard import Dashboard, DashboardConfig

    stop_requested = threading.Event()

    def simulate() -> None:
        cycle_count = 0
        while not stop_requested.is_set() and (cycles <= 0 or cycle_count < cycles):
            tracer.set_cycle(environment.cycle)
            environment.step()
            cycle_count += 1

    sim_thread = threading.Thread(target=simulate, name="alife-sim", daemon=True)
    sim_thread.start()

    dashboard = Dashboard(environment, tracer, DashboardConfig())
    try:
        while sim_thread.is_alive():
            if dashboard.poll_quit_requested():
                break
            dashboard.render_frame()
    finally:
        stop_requested.set()
        dashboard.close()
        sim_thread.join(timeout=2.0)


def run_dashboard_server(
    environment: Environment, tracer: PhylogeneticTracer, cycles: int, host: str, port: int
) -> None:
    """Run the simulation on a background thread while a stdlib HTTP server
    streams the same lineage-color + phosphor-burn visualization as MJPEG
    on the main thread, fully decoupled from each other's clock rates —
    the same pattern :func:`run_dashboard` uses for the Pygame window.
    """
    from viz.server import DashboardServerConfig, FrameProducer, build_server

    stop_requested = threading.Event()

    def simulate() -> None:
        cycle_count = 0
        while not stop_requested.is_set() and (cycles <= 0 or cycle_count < cycles):
            tracer.set_cycle(environment.cycle)
            environment.step()
            cycle_count += 1

    sim_thread = threading.Thread(target=simulate, name="alife-sim", daemon=True)
    sim_thread.start()

    producer = FrameProducer(environment, DashboardServerConfig(host=host, port=port))
    producer.start()
    server = build_server(environment, tracer, producer, DashboardServerConfig(host=host, port=port))
    print(f"dashboard-server listening on http://{host}:{port}/")
    server_thread = threading.Thread(target=server.serve_forever, name="alife-http", daemon=True)
    server_thread.start()
    try:
        while sim_thread.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\ninterrupted")
    finally:
        stop_requested.set()
        server.shutdown()
        server.server_close()
        producer.stop()
        sim_thread.join(timeout=2.0)


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    if args.resume_from:
        environment, tracer = resume_traced_environment(args.resume_from)
    else:
        environment, tracer = build_traced_environment(args.config)

    if args.mode == "headless":
        metrics_writer = MetricsCSVWriter(args.metrics_csv) if args.metrics_csv else None
        run_headless(
            environment, tracer, cycles=args.cycles, report_interval=args.report_interval, metrics_writer=metrics_writer
        )
    elif args.mode == "dashboard":
        run_dashboard(environment, tracer, cycles=args.cycles)
    else:
        run_dashboard_server(environment, tracer, cycles=args.cycles, host=args.host, port=args.port)

    if args.checkpoint_out:
        save_checkpoint(environment, tracer, args.checkpoint_out)
        print(f"checkpoint saved to {args.checkpoint_out}")


if __name__ == "__main__":
    main()
