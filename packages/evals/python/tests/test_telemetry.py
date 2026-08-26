import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import threading
from unittest.mock import patch

from openpond_evals.telemetry import (
    BufferedTelemetryEmitter,
    AsyncTelemetryEmitter,
    RunTelemetryBatch,
    RunTelemetryLineage,
    TelemetryBuilder,
    telemetry_idempotency_key,
)


FIXTURES = Path(__file__).parents[2] / "conformance" / "telemetry" / "v1"


def test_shared_conformance_fixtures() -> None:
    valid = json.loads((FIXTURES / "valid-batch.json").read_text())
    invalid = json.loads((FIXTURES / "invalid-batch.json").read_text())
    assert len(RunTelemetryBatch.model_validate(valid).events) == 1
    with pytest.raises(ValidationError):
        RunTelemetryBatch.model_validate(invalid)


def test_builder_assigns_ordered_stable_ids_and_validates_metrics() -> None:
    lineage = RunTelemetryLineage.model_validate({
        "modelProjectId": "project-1", "runId": "run-1", "modelVersionId": "version-1",
        "harnessReleaseHash": "a" * 64, "tasksetReleaseHash": "b" * 64,
        "environmentReleaseHash": None, "checkpointId": None, "step": 1,
        "rolloutGroupId": "group-1", "attemptId": None, "scenarioId": "scenario-1",
    })
    builder = TelemetryBuilder(lineage)
    event = builder.event(occurred_at=datetime(2026, 8, 25, tzinfo=timezone.utc), source="optimizer", event_type="optimizer_step_completed")
    observation = builder.observation(metric_id="optimizer.loss", event=event, value=0.5, dimensions={"split": "train"})
    assert event.sequence == 0
    assert observation.sequence == 1
    assert telemetry_idempotency_key(observation).startswith("run-1:1:metric-")
    with pytest.raises(ValidationError):
        builder.observation(metric_id="optimizer.loss", event=event, value=0.5, dimensions={"unbounded": "no"})


def test_emitter_requeues_failed_batches() -> None:
    valid = RunTelemetryBatch.model_validate(json.loads((FIXTURES / "valid-batch.json").read_text()))
    emitter = BufferedTelemetryEmitter("https://example.invalid/telemetry", "token", retry_attempts=1)
    emitter.emit_event(valid.events[0])
    with patch("urllib.request.urlopen", side_effect=OSError("offline")):
        with pytest.raises(OSError):
            emitter.flush()
    with patch("urllib.request.urlopen") as request:
        request.return_value.__enter__.return_value.read.return_value = b'{"accepted":1}'
        assert emitter.flush() == 1


def test_builder_preserves_unique_sequence_under_concurrency() -> None:
    valid = RunTelemetryBatch.model_validate(json.loads((FIXTURES / "valid-batch.json").read_text()))
    builder = TelemetryBuilder(valid.events[0].lineage)
    with ThreadPoolExecutor(max_workers=8) as pool:
        events = list(pool.map(lambda _: builder.event(
            occurred_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            source="runtime",
            event_type="run_state_changed",
        ), range(100)))
    assert sorted(event.sequence for event in events) == list(range(100))
    assert len({event.event_id for event in events}) == 100


def test_async_emitter_applies_backpressure_and_flushes_on_close() -> None:
    valid = RunTelemetryBatch.model_validate(json.loads((FIXTURES / "valid-batch.json").read_text()))
    entered = threading.Event()
    release = threading.Event()

    class BlockingEmitter:
        def __init__(self) -> None:
            self.events = []
            self.flushed = False

        def emit_event(self, event) -> None:
            entered.set()
            release.wait(timeout=2)
            self.events.append(event)

        def emit_observation(self, observation) -> None:
            self.events.append(observation)

        def flush(self) -> int:
            self.flushed = True
            return len(self.events)

    target = BlockingEmitter()
    emitter = AsyncTelemetryEmitter(target, max_queue_items=1)
    emitter.emit_event(valid.events[0])
    assert entered.wait(timeout=2)
    emitter.emit_event(valid.events[0])
    with pytest.raises(BufferError):
        emitter.emit_event(valid.events[0])
    release.set()
    emitter.close()
    assert len(target.events) == 2
    assert target.flushed is True


def test_async_emitter_surfaces_delivery_failure_at_terminal_flush() -> None:
    valid = RunTelemetryBatch.model_validate(json.loads((FIXTURES / "valid-batch.json").read_text()))

    class FailingEmitter:
        def emit_event(self, event) -> None:
            raise OSError("delivery failed")

        def emit_observation(self, observation) -> None:
            raise OSError("delivery failed")

        def flush(self) -> int:
            return 0

    emitter = AsyncTelemetryEmitter(FailingEmitter())
    emitter.emit_event(valid.events[0])
    with pytest.raises(RuntimeError, match="telemetry delivery failed"):
        emitter.close()
