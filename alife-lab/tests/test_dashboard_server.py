"""Phase-4 verification tests for viz/server.py — MJPEG live dashboard."""

from __future__ import annotations

import http.client
import json
import sys
import threading
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.metrics import PhylogeneticTracer  # noqa: E402
from core.environment import Environment, EnvironmentConfig  # noqa: E402
from viz.server import DashboardServerConfig, FrameProducer, build_server  # noqa: E402

_JPEG_MAGIC = b"\xff\xd8\xff"


def make_env() -> Environment:
    config = EnvironmentConfig(width=8, height=8, probe_spawn_count=0, mutation_rate=0.0)
    return Environment(config=config, rng=np.random.default_rng(42))


def test_render_once_produces_a_valid_jpeg_at_the_configured_dimensions() -> None:
    env = make_env()
    config = DashboardServerConfig(cell_size=3)
    producer = FrameProducer(env, config)

    frame = producer.render_once()

    assert frame.startswith(_JPEG_MAGIC)
    # a real-decode round trip isn't worth a new dependency; the magic
    # number plus a sane non-trivial size is enough to confirm pygame
    # actually encoded something rather than returning empty bytes.
    assert len(frame) > 100
    assert producer.frame_dimensions() == (8 * 3, 8 * 3)


def test_http_server_serves_index_stats_and_stream(tmp_path) -> None:
    env = make_env()
    tracer = PhylogeneticTracer()
    for founder in env.threads.values():
        tracer.on_birth(founder, None, env)
    env.on_birth = lambda child, parent: tracer.on_birth(child, parent, env)
    env.on_death = tracer.on_death
    env.on_overwrite = tracer.on_overwrite

    config = DashboardServerConfig(host="127.0.0.1", port=0, target_fps=30)
    producer = FrameProducer(env, config)
    producer.start()
    server = build_server(env, tracer, producer, config)
    port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    try:
        producer.latest_frame(timeout=2.0)  # wait for the first frame to render

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/")
        index_response = conn.getresponse()
        index_body = index_response.read()
        assert index_response.status == 200
        assert b"stream.mjpg" in index_body
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/stats.json")
        stats_response = conn.getresponse()
        stats = json.loads(stats_response.read())
        assert stats_response.status == 200
        assert "cycle" in stats
        assert "shannon_entropy" in stats
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/stream.mjpg")
        stream_response = conn.getresponse()
        assert stream_response.status == 200
        assert "multipart/x-mixed-replace" in stream_response.getheader("Content-Type")
        chunk = stream_response.read(4096)
        assert b"--alife-frame" in chunk
        assert _JPEG_MAGIC in chunk
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/nonexistent")
        missing_response = conn.getresponse()
        assert missing_response.status == 404
        missing_response.read()
        conn.close()
    finally:
        server.shutdown()
        server.server_close()
        producer.stop()
