"""viz/server.py — Mobile/Cloud Live Dashboard Server.

Streams the exact same lineage-color + phosphor-burn visualization
``viz/dashboard.py`` renders into a Pygame window, over plain HTTP
instead, so any phone or browser can watch a running simulation live via
a plain ``<img>`` tag — no app, no Pygame on the client, and (per the
lab's stdlib-only preference) no new dependencies: the MJPEG multipart
stream and the HTML page are both built from ``http.server`` and plain
strings.

Architecture
------------
Three independently-clocked threads share the same live ``Environment``/
``PhylogeneticTracer`` objects, exactly like ``main.py``'s existing
headless/dashboard decoupling:

1. The simulation thread (driven by ``main.py``) advances
   ``Environment.step()`` as fast as it can.
2. :class:`FrameProducer` renders one JPEG-encoded frame at
   ``DashboardServerConfig.target_fps`` on its own thread, reusing
   ``viz/dashboard.py``'s pure-numpy ``build_strain_color_image``/
   ``apply_phosphor_overlay``/``PhosphorDecayLayer`` untouched — none of
   those ever touch Pygame's display/font subsystems, only
   ``viz.dashboard.Dashboard.__init__`` does, which this module never
   imports.
3. :class:`DashboardHTTPServer` (a stdlib ``ThreadingHTTPServer``) serves
   the single latest frame to every connected MJPEG stream and
   ``/stats.json`` poller, so N simultaneous viewers never re-render or
   re-encode anything themselves; they just read whatever
   :class:`FrameProducer` most recently built.

JPEG encoding without a real display
-------------------------------------
``pygame.image.save`` can JPEG/PNG-encode a ``Surface`` with no display
ever opened, as long as ``SDL_VIDEODRIVER=dummy`` is set before Pygame's
video subsystem initializes (confirmed empirically; this module sets the
default itself so callers don't have to remember to). This is exactly
the "surface-only encoding" the lab's design called for — no window, no
display server requirement, safe to run in any headless container.

Never imported by ``--mode headless`` or ``--mode dashboard``: like
``viz/dashboard.py``, this module (and therefore Pygame) is only ever
imported once ``main.py``'s ``--mode dashboard-server`` branch actually
runs.
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, Tuple

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import pygame  # noqa: E402 — must follow the SDL_VIDEODRIVER default above

from analytics.metrics import PhylogeneticTracer, take_snapshot
from core.environment import Environment
from viz.dashboard import PhosphorDecayLayer, apply_phosphor_overlay, build_strain_color_image

_BOUNDARY = "alife-frame"

_INDEX_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>alife-lab — live</title>
<style>
  body { background:#0e0f12; color:#dce6e8; font-family: monospace; margin:0; display:flex; flex-wrap:wrap; }
  img { image-rendering: pixelated; max-width: 100%; }
  #stats { padding: 16px; min-width: 260px; }
  #stats div { margin-bottom: 8px; }
  .label { color:#78dcd2; display:block; font-size: 12px; }
  .value { font-size: 18px; font-weight: bold; }
</style>
</head>
<body>
<img src="/stream.mjpg" alt="live simulation feed">
<div id="stats"><div class="value">loading...</div></div>
<script>
async function poll() {
  try {
    const r = await fetch("/stats.json");
    const s = await r.json();
    document.getElementById("stats").innerHTML = `
      <div><span class="label">CYCLE</span><span class="value">${s.cycle}</span></div>
      <div><span class="label">ACTIVE THREADS</span><span class="value">${s.active_threads}</span></div>
      <div><span class="label">SHANNON ENTROPY</span><span class="value">${s.shannon_entropy.toFixed(3)} bits/byte</span></div>
      <div><span class="label">TOTAL BIRTHS</span><span class="value">${s.total_births}</span></div>
      <div><span class="label">TOTAL DEATHS</span><span class="value">${s.total_deaths}</span></div>
      <div><span class="label">SPECIATION EVENTS</span><span class="value">${s.speciation_count}</span></div>
      <div><span class="label">NOISE &gt; SEED TAKEOVERS</span><span class="value">${s.noise_defeats_seed}</span></div>
      <div><span class="label">SEED &gt; NOISE TAKEOVERS</span><span class="value">${s.seed_defeats_noise}</span></div>
    `;
  } catch (e) { /* server still starting up — try again next tick */ }
  setTimeout(poll, 1000);
}
poll();
</script>
</body>
</html>
"""


@dataclass
class DashboardServerConfig:
    """Visual/network tuning, independent of any simulation physics."""

    host: str = "0.0.0.0"
    port: int = 8000
    cell_size: int = 3
    target_fps: int = 15
    phosphor_decay: float = 0.85


class FrameProducer:
    """Renders the live ``Environment`` into a JPEG frame at a fixed rate
    on its own thread, so every connected viewer reads the same
    already-built bytes instead of each re-rendering/re-encoding
    independently.
    """

    def __init__(self, environment: Environment, config: DashboardServerConfig) -> None:
        self.environment = environment
        self.config = config
        self.phosphor = PhosphorDecayLayer(
            environment.config.height, environment.config.width, config.phosphor_decay
        )
        pygame.display.init()
        self._surface = pygame.Surface((environment.config.width, environment.config.height))
        self._condition = threading.Condition()
        self._latest_frame: Optional[bytes] = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="alife-frame-producer", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2.0)
        pygame.display.quit()

    def latest_frame(self, timeout: Optional[float] = None) -> Optional[bytes]:
        """Block until a newer frame than the caller has already seen is
        ready (or ``timeout`` elapses), then return the latest bytes."""
        with self._condition:
            self._condition.wait(timeout=timeout)
            return self._latest_frame

    def render_once(self) -> bytes:
        """Render and JPEG-encode exactly one frame from the environment's
        current live state, synchronously — used both by the background
        loop and directly by isolation tests that don't want a thread.
        """
        self.phosphor.flash(self.environment.last_executed_addresses)
        color_image = build_strain_color_image(self.environment)
        composited = apply_phosphor_overlay(color_image, self.phosphor.heat)
        self.phosphor.tick()
        # surfarray expects the array's first axis to map to surface width,
        # exactly like viz.dashboard.Dashboard.render_frame.
        pygame.surfarray.blit_array(self._surface, composited.transpose(1, 0, 2))
        scaled = pygame.transform.scale(
            self._surface,
            (
                self.environment.config.width * self.config.cell_size,
                self.environment.config.height * self.config.cell_size,
            ),
        )
        buffer = io.BytesIO()
        pygame.image.save(scaled, buffer, "frame.jpg")
        return buffer.getvalue()

    def frame_dimensions(self) -> Tuple[int, int]:
        return (
            self.environment.config.width * self.config.cell_size,
            self.environment.config.height * self.config.cell_size,
        )

    def _run(self) -> None:
        interval = 1.0 / max(self.config.target_fps, 1)
        while not self._stop.is_set():
            frame = self.render_once()
            with self._condition:
                self._latest_frame = frame
                self._condition.notify_all()
            time.sleep(interval)


class DashboardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: Tuple[str, int],
        handler_cls: type,
        environment: Environment,
        tracer: PhylogeneticTracer,
        producer: FrameProducer,
    ) -> None:
        super().__init__(address, handler_cls)
        self.environment = environment
        self.tracer = tracer
        self.producer = producer


class _Handler(BaseHTTPRequestHandler):
    server: DashboardHTTPServer  # narrows the inherited Any-typed attribute

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 — stdlib signature
        pass  # keep stdout limited to main.py's own periodic metrics reports

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._serve_index()
        elif self.path == "/stream.mjpg":
            self._serve_stream()
        elif self.path == "/stats.json":
            self._serve_stats()
        else:
            self.send_error(404)

    def _serve_index(self) -> None:
        body = _INDEX_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={_BOUNDARY}")
        self.end_headers()
        try:
            while True:
                frame = self.server.producer.latest_frame(timeout=5.0)
                if frame is None:
                    continue
                self.wfile.write(f"--{_BOUNDARY}\r\n".encode("ascii"))
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii"))
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # the viewer navigated away or lost connection — not our problem

    def _serve_stats(self) -> None:
        snapshot = take_snapshot(self.server.environment, self.server.tracer)
        body = json.dumps(
            {
                "cycle": snapshot.cycle,
                "active_threads": snapshot.active_threads,
                "shannon_entropy": snapshot.shannon_entropy,
                "total_births": snapshot.total_births,
                "total_deaths": snapshot.total_deaths,
                "speciation_count": snapshot.speciation_count,
                "noise_defeats_seed": snapshot.noise_defeats_seed,
                "seed_defeats_noise": snapshot.seed_defeats_noise,
                "dominant_lineages": snapshot.dominant_lineages,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def build_server(
    environment: Environment,
    tracer: PhylogeneticTracer,
    producer: FrameProducer,
    config: DashboardServerConfig,
) -> DashboardHTTPServer:
    return DashboardHTTPServer((config.host, config.port), _Handler, environment, tracer, producer)
