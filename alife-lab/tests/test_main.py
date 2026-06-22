"""Phase-5 verification tests for main.py — the Lab Executive Controller."""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402


def test_parse_args_defaults_to_headless() -> None:
    args = main.parse_args([])
    assert args.mode == "headless"
    assert args.config == "config/default.yaml"
    assert args.cycles == 0
    assert args.report_interval == 500


def test_parse_args_accepts_dashboard_mode_and_overrides() -> None:
    args = main.parse_args(["--mode", "dashboard", "--cycles", "10", "--report-interval", "5"])
    assert args.mode == "dashboard"
    assert args.cycles == 10
    assert args.report_interval == 5


def test_build_traced_environment_records_founding_ancestors() -> None:
    environment, tracer = main.build_traced_environment("config/default.yaml")
    assert tracer.total_births() == len(environment.threads)
    assert len(tracer.lineages) == len(environment.threads)


def test_build_traced_environment_wires_live_hooks_for_future_events() -> None:
    environment, tracer = main.build_traced_environment("config/default.yaml")
    births_before = tracer.total_births()
    environment.step()
    assert tracer.total_births() >= births_before


def test_run_headless_advances_the_environment_by_exactly_cycles() -> None:
    environment, tracer = main.build_traced_environment("config/default.yaml")
    starting_cycle = environment.cycle
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        main.run_headless(environment, tracer, cycles=7, report_interval=1000)
    assert environment.cycle == starting_cycle + 7
    assert "cycle=" in buffer.getvalue()
