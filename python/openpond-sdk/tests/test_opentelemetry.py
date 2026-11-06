"""Failure story: replayed traces cannot duplicate tasks, and background export
must select/redact content and surface foreign receipts without breaking agents.
Real OTel spans, BatchSpanProcessor and HTTP sockets exercise the boundary.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
pytest.importorskip("opentelemetry.sdk.trace")

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from ponder_sdk import Client
from ponder_sdk.opentelemetry import OpenPondSpanExporter, OpenPondSpanExportError


def test_span_http_replay_and_background_shutdown():
    requests = []
    state = {"foreign_receipt": False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            assert self.path == "/v1/dataset-workspaces/dataset-one/tasks"
            assert self.headers["Authorization"] == "Bearer fixture-key"
            assert self.headers["X-OpenPond-Team-Id"] == "team"
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            payload = json.dumps({"schemaVersion": "openpond.datasetTaskReceipt.v1",
                                  "teamId": "foreign" if state["foreign_receipt"] else "team",
                                  "datasetId": "dataset-one", "operationId": body["operationId"],
                                  "taskId": "task", "receivedAt": "2026-11-06T16:00:00Z",
                                  "revision": 1, "state": "saved", "trainingUseAuthorized": False}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    collector = InMemorySpanExporter()
    capture = TracerProvider()
    capture.add_span_processor(SimpleSpanProcessor(collector))
    tracer = capture.get_tracer("test")
    with tracer.start_as_current_span("agent run") as span:
        span.set_attribute("selected", True)
        span.set_attribute("secret", "never-upload")
    with tracer.start_as_current_span("network") as span:
        span.set_attribute("secret", "never-upload")
    spans = collector.get_finished_spans()

    def project_span(span):
        if not (span.attributes or {}).get("selected"):
            return None
        return {"name": span.name, "input": {"prompt": "sanitized"}}

    try:
        with Client(base_url=f"http://127.0.0.1:{server.server_port}", api_key="fixture-key", team_id="team", timeout=2) as client:
            exporter = OpenPondSpanExporter(client=client, dataset_id="dataset-one", project_span=project_span)
            assert exporter.export([*spans, spans[0]]) == SpanExportResult.SUCCESS
            assert len(requests) == 1
            assert requests[0]["task"]["input"] == {"prompt": "sanitized"}
            assert "never-upload" not in json.dumps(requests)
            state["foreign_receipt"] = True
            assert exporter.export([spans[0]]) == SpanExportResult.FAILURE
            assert isinstance(exporter.last_export_error, OpenPondSpanExportError)
            assert len(exporter.last_export_error.failures) == 1
            state["foreign_receipt"] = False
            assert exporter.export([spans[0]]) == SpanExportResult.SUCCESS
            assert requests[2] == requests[0]
            assert exporter.last_export_error is None
            provider = TracerProvider()
            provider.add_span_processor(BatchSpanProcessor(exporter, max_queue_size=4, max_export_batch_size=2))
            with provider.get_tracer("batch").start_as_current_span("agent run") as span:
                span.set_attribute("selected", True)
            provider.shutdown()
            assert len(requests) == 4
            assert exporter.export([spans[0]]) == SpanExportResult.FAILURE
    finally:
        capture.shutdown()
        server.shutdown()
        server.server_close()
        thread.join()


def test_bounds_and_lifecycle():
    collector = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(collector))
    with provider.get_tracer("test").start_as_current_span("run"):
        pass
    span = collector.get_finished_spans()[0]
    started = threading.Event()
    release = threading.Event()
    results = []

    class GatedClient:
        writes = 0

        def add_task(self, *_args, **_kwargs):
            self.writes += 1
            started.set()
            assert release.wait(2)

    client = GatedClient()
    exporter = OpenPondSpanExporter(client=client, dataset_id="dataset", max_export_batch_size=1,
                                   project_span=lambda _span: {"name": "task", "input": {}})
    assert exporter.export([span, span]) == SpanExportResult.FAILURE
    assert client.writes == 0
    worker = threading.Thread(target=lambda: results.append(exporter.export([span])))
    worker.start()
    try:
        assert started.wait(2)
        assert exporter.export([span]) == SpanExportResult.FAILURE
        assert not exporter.force_flush(timeout_millis=1)
        release.set()
        worker.join(2)
        assert exporter.force_flush(timeout_millis=100)
        assert results == [SpanExportResult.SUCCESS]
        exporter.shutdown()
        assert exporter.export([span]) == SpanExportResult.FAILURE
        assert client.writes == 1
    finally:
        release.set()
        worker.join(2)
        provider.shutdown()
