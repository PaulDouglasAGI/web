"""viz/dashboard.py — Bio-Informatics Spectrogram Dashboard.

A professional, strictly read-only Pygame monitoring interface. It never
calls ``Environment.step()`` itself and never mutates any simulation
state — ``main.py`` is responsible for advancing the simulation (typically
on a separate thread, completely decoupled from this module's frame rate)
and simply hands this module the same live :class:`Environment` and
:class:`PhylogeneticTracer` objects to read from on every render tick.

Rendering pipeline, once per frame
-----------------------------------
1. Build a (height, width, 3) RGB image directly from
   ``Environment.strain``/``Environment.owner`` — Cold Cyan for seed
   descendants, High-Energy Amber for spontaneous noise strains, Dark
   Slate for unallocated background.
2. Blend in the phosphor-burn layer: every coordinate any thread's
   instruction pointer touched since the last frame flashes white-hot and
   fades exponentially over subsequent frames, tracing live execution
   pathways across the lattice.
3. Upscale the per-byte image by ``cell_size`` and blit it to the window.
4. Draw the right-hand data readout from a fresh
   ``analytics.metrics.MetricsSnapshot``.

Because the simulation may be advancing far faster than the display can
draw, this module only ever sees whichever ``Environment.last_executed_addresses``
happened to be present at the instant it samples it — a deliberate,
documented sampling tradeoff that is the entire point of decoupling
visualization from the processing loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np
import pygame

from analytics.metrics import MetricsSnapshot, PhylogeneticTracer, take_snapshot
from core.environment import STRAIN_NOISE, STRAIN_SEED, Environment

COLD_CYAN: Tuple[int, int, int] = (76, 230, 222)
HIGH_ENERGY_AMBER: Tuple[int, int, int] = (255, 176, 32)
DARK_SLATE: Tuple[int, int, int] = (28, 31, 36)
WHITE_HOT: Tuple[int, int, int] = (255, 255, 255)
SIDEBAR_BG: Tuple[int, int, int] = (18, 20, 24)
TEXT_PRIMARY: Tuple[int, int, int] = (220, 230, 235)
TEXT_ACCENT: Tuple[int, int, int] = (120, 220, 210)


@dataclass
class DashboardConfig:
    """Visual/window tuning, independent of any simulation physics."""

    cell_size: int = 3
    sidebar_width: int = 260
    target_fps: int = 30
    phosphor_decay: float = 0.85
    window_title: str = "THE LABORATORY — Digital Evolution Spectrogram"


class PhosphorDecayLayer:
    """A per-coordinate heat buffer that flashes to 1.0 on execution and
    exponentially decays toward 0.0 every frame, independent of the
    simulation's own clock cycles."""

    def __init__(self, height: int, width: int, decay: float) -> None:
        self.heat: np.ndarray = np.zeros((height, width), dtype=np.float32)
        self.decay = decay
        self._width = width

    def flash(self, addresses: list[int]) -> None:
        if not addresses:
            return
        rows, cols = np.divmod(np.asarray(addresses, dtype=np.int64), self._width)
        self.heat[rows, cols] = 1.0

    def tick(self) -> None:
        self.heat *= self.decay


def build_strain_color_image(environment: Environment) -> np.ndarray:
    """A (height, width, 3) uint8 RGB image colored purely by lineage
    provenance, vectorized over the whole lattice at once."""
    height, width = environment.config.height, environment.config.width
    strain_grid = environment.strain.reshape(height, width)
    image = np.empty((height, width, 3), dtype=np.uint8)
    image[:] = DARK_SLATE
    image[strain_grid == STRAIN_SEED] = COLD_CYAN
    image[strain_grid == STRAIN_NOISE] = HIGH_ENERGY_AMBER
    return image


def apply_phosphor_overlay(color_image: np.ndarray, heat: np.ndarray) -> np.ndarray:
    """Blend white-hot execution flashes over the base lineage-color image."""
    intensity = heat[:, :, None]
    white = np.array(WHITE_HOT, dtype=np.float32)
    blended = color_image.astype(np.float32) * (1.0 - intensity) + white * intensity
    return np.clip(blended, 0, 255).astype(np.uint8)


class Dashboard:
    """The read-only Pygame monitoring window."""

    def __init__(
        self,
        environment: Environment,
        tracer: PhylogeneticTracer,
        config: Optional[DashboardConfig] = None,
    ) -> None:
        self.environment = environment
        self.tracer = tracer
        self.config = config or DashboardConfig()
        self.phosphor = PhosphorDecayLayer(
            environment.config.height, environment.config.width, self.config.phosphor_decay
        )

        pygame.init()
        lattice_px_w = environment.config.width * self.config.cell_size
        lattice_px_h = environment.config.height * self.config.cell_size
        window_size = (lattice_px_w + self.config.sidebar_width, lattice_px_h)
        self.screen = pygame.display.set_mode(window_size)
        pygame.display.set_caption(self.config.window_title)
        self.font = pygame.font.SysFont("consolas", 16)
        self.font_bold = pygame.font.SysFont("consolas", 18, bold=True)
        self.clock = pygame.time.Clock()
        self._lattice_surface = pygame.Surface(
            (environment.config.width, environment.config.height)
        )

    def poll_quit_requested(self) -> bool:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return True
            if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                return True
        return False

    def render_frame(self) -> None:
        """Render exactly one frame from the environment/tracer's current
        live state. Safe to call at any rate, decoupled from sim speed.
        """
        self.phosphor.flash(self.environment.last_executed_addresses)
        color_image = build_strain_color_image(self.environment)
        composited = apply_phosphor_overlay(color_image, self.phosphor.heat)
        self.phosphor.tick()

        # surfarray expects the array's first axis to map to surface width.
        pygame.surfarray.blit_array(self._lattice_surface, composited.transpose(1, 0, 2))
        scaled = pygame.transform.scale(
            self._lattice_surface,
            (
                self.environment.config.width * self.config.cell_size,
                self.environment.config.height * self.config.cell_size,
            ),
        )
        self.screen.blit(scaled, (0, 0))

        snapshot = take_snapshot(self.environment, self.tracer)
        self._draw_sidebar(snapshot, x_offset=scaled.get_width())

        pygame.display.flip()
        self.clock.tick(self.config.target_fps)

    def _draw_sidebar(self, snapshot: MetricsSnapshot, x_offset: int) -> None:
        sidebar_rect = pygame.Rect(x_offset, 0, self.config.sidebar_width, self.screen.get_height())
        pygame.draw.rect(self.screen, SIDEBAR_BG, sidebar_rect)

        lines = [
            ("CYCLE", str(snapshot.cycle), TEXT_ACCENT),
            ("ACTIVE THREADS", str(snapshot.active_threads), TEXT_PRIMARY),
            ("GENERATION DELTA", str(self._generation_delta()), TEXT_PRIMARY),
            ("SHANNON ENTROPY", f"{snapshot.shannon_entropy:.3f} bits/byte", TEXT_PRIMARY),
            ("TOTAL BIRTHS", str(snapshot.total_births), TEXT_PRIMARY),
            ("TOTAL DEATHS", str(snapshot.total_deaths), TEXT_PRIMARY),
            ("SPECIATION EVENTS", str(snapshot.speciation_count), TEXT_PRIMARY),
            ("NOISE > SEED TAKEOVERS", str(snapshot.noise_defeats_seed), HIGH_ENERGY_AMBER),
            ("SEED > NOISE TAKEOVERS", str(snapshot.seed_defeats_noise), COLD_CYAN),
        ]
        y = 16
        for label, value, color in lines:
            label_surface = self.font.render(label, True, TEXT_ACCENT)
            value_surface = self.font_bold.render(value, True, color)
            self.screen.blit(label_surface, (x_offset + 16, y))
            self.screen.blit(value_surface, (x_offset + 16, y + 18))
            y += 46

        y += 8
        header = self.font_bold.render("SPECIATION POPULATION %", True, TEXT_ACCENT)
        self.screen.blit(header, (x_offset + 16, y))
        y += 26
        total = max(1, snapshot.active_threads)
        for lineage_id, count in snapshot.dominant_lineages:
            pct = 100.0 * count / total
            row = self.font.render(f"lineage {lineage_id}: {pct:5.1f}%", True, TEXT_PRIMARY)
            self.screen.blit(row, (x_offset + 16, y))
            y += 22

    def _generation_delta(self) -> int:
        living = self.environment.living_threads()
        if not living:
            return 0
        generations = [t.generation for t in living]
        return max(generations) - min(generations)

    def close(self) -> None:
        pygame.quit()
