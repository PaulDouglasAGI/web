"""analytics/export.py — incremental CSV metrics export.

Appends one row per :class:`~analytics.metrics.MetricsSnapshot` to a CSV
file, opening the file in append mode on every write rather than holding
the run's full snapshot history in memory — the same reason
``main.py``'s headless reporter never accumulates a snapshot list either.
"""

from __future__ import annotations

import csv
from pathlib import Path

from analytics.metrics import MetricsSnapshot

FIELDNAMES = [
    "cycle",
    "shannon_entropy",
    "active_threads",
    "population_seed",
    "population_noise",
    "total_births",
    "total_deaths",
    "speciation_count",
    "noise_defeats_seed",
    "seed_defeats_noise",
]


class MetricsCSVWriter:
    """Writes the CSV header once, then appends one row per snapshot."""

    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._wrote_header = self._path.exists() and self._path.stat().st_size > 0

    def write(self, snapshot: MetricsSnapshot) -> None:
        with self._path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
            if not self._wrote_header:
                writer.writeheader()
                self._wrote_header = True
            writer.writerow(
                {
                    "cycle": snapshot.cycle,
                    "shannon_entropy": snapshot.shannon_entropy,
                    "active_threads": snapshot.active_threads,
                    "population_seed": snapshot.population_by_strain.get("seed", 0),
                    "population_noise": snapshot.population_by_strain.get("noise", 0),
                    "total_births": snapshot.total_births,
                    "total_deaths": snapshot.total_deaths,
                    "speciation_count": snapshot.speciation_count,
                    "noise_defeats_seed": snapshot.noise_defeats_seed,
                    "seed_defeats_noise": snapshot.seed_defeats_noise,
                }
            )
