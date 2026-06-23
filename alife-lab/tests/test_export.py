"""Phase-3 verification tests for analytics/export.py — CSV metrics export."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.export import FIELDNAMES, MetricsCSVWriter  # noqa: E402
from analytics.metrics import MetricsSnapshot  # noqa: E402


def make_snapshot(cycle: int) -> MetricsSnapshot:
    return MetricsSnapshot(
        cycle=cycle,
        shannon_entropy=6.5,
        active_threads=10,
        population_by_strain={"seed": 7, "noise": 3},
        total_births=20,
        total_deaths=10,
        speciation_count=4,
        noise_defeats_seed=1,
        seed_defeats_noise=0,
        dominant_lineages=[(1, 5)],
    )


def test_write_creates_header_exactly_once(tmp_path: Path) -> None:
    csv_path = tmp_path / "metrics.csv"
    writer = MetricsCSVWriter(str(csv_path))
    writer.write(make_snapshot(1))
    writer.write(make_snapshot(2))

    rows = list(csv.reader(csv_path.open()))
    assert rows[0] == FIELDNAMES
    assert len(rows) == 3  # header + 2 data rows


def test_write_appends_to_an_existing_file_without_a_second_header(tmp_path: Path) -> None:
    csv_path = tmp_path / "metrics.csv"
    MetricsCSVWriter(str(csv_path)).write(make_snapshot(1))

    second_writer = MetricsCSVWriter(str(csv_path))
    second_writer.write(make_snapshot(2))

    rows = list(csv.reader(csv_path.open()))
    assert rows[0] == FIELDNAMES
    assert sum(1 for row in rows if row == FIELDNAMES) == 1
    assert len(rows) == 3


def test_row_values_match_the_snapshot(tmp_path: Path) -> None:
    csv_path = tmp_path / "metrics.csv"
    MetricsCSVWriter(str(csv_path)).write(make_snapshot(42))

    row = next(csv.DictReader(csv_path.open()))
    assert row["cycle"] == "42"
    assert row["population_seed"] == "7"
    assert row["population_noise"] == "3"
    assert row["speciation_count"] == "4"
    assert row["noise_defeats_seed"] == "1"
