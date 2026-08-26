"""Versioned training telemetry models and a bounded buffered HTTP emitter."""

from __future__ import annotations

import json
import hashlib
import queue
import threading
import time
import urllib.request
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


CORE_METRIC_DIMENSIONS: dict[str, frozenset[str]] = {
    "reward.mean": frozenset({"split", "grader"}),
    "reward.variance": frozenset({"split"}),
    "reward.constant_group_rate": frozenset({"split"}),
    "attempt.valid_rate": frozenset({"split", "failureOwner"}),
    "attempt.failure_count": frozenset({"split", "failureOwner", "failureClass"}),
    "optimizer.loss": frozenset({"split"}),
    "optimizer.learning_rate": frozenset({"split"}),
    "optimizer.kl": frozenset({"split"}),
    "optimizer.entropy": frozenset({"split"}),
    "optimizer.gradient_norm": frozenset({"split"}),
    "optimizer.clip_fraction": frozenset({"split"}),
    "output.duplicate_rate": frozenset({"split"}),
    "output.unique_count": frozenset({"split"}),
    "tokens.input": frozenset({"split", "source"}),
    "tokens.output": frozenset({"split", "source"}),
    "runtime.latency_ms": frozenset({"operation", "provider"}),
    "runtime.throughput": frozenset({"operation", "provider"}),
    "gpu.memory_bytes": frozenset({"provider", "gpuType"}),
    "gpu.utilization": frozenset({"provider", "gpuType"}),
    "cost.usd": frozenset({"provider", "resource"}),
}
RATIO_METRICS = frozenset({"reward.constant_group_rate", "attempt.valid_rate", "optimizer.clip_fraction", "output.duplicate_rate", "gpu.utilization"})


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RunTelemetryLineage(ContractModel):
    model_project_id: str = Field(alias="modelProjectId", min_length=1, max_length=200)
    run_id: str = Field(alias="runId", min_length=1, max_length=200)
    model_version_id: str | None = Field(alias="modelVersionId", default=None)
    harness_release_hash: str = Field(alias="harnessReleaseHash", pattern=r"^[a-f0-9]{64}$")
    taskset_release_hash: str = Field(alias="tasksetReleaseHash", pattern=r"^[a-f0-9]{64}$")
    environment_release_hash: str | None = Field(alias="environmentReleaseHash", default=None, pattern=r"^[a-f0-9]{64}$")
    checkpoint_id: str | None = Field(alias="checkpointId", default=None)
    step: int | None = Field(default=None, ge=0)
    rollout_group_id: str | None = Field(alias="rolloutGroupId", default=None)
    attempt_id: str | None = Field(alias="attemptId", default=None)
    scenario_id: str | None = Field(alias="scenarioId", default=None)


class RunTelemetryEvent(ContractModel):
    schema_version: Literal["openpond.runTelemetryEvent.v1"] = Field(alias="schemaVersion")
    event_id: str = Field(alias="eventId", min_length=1, max_length=200)
    sequence: int = Field(ge=0)
    occurred_at: datetime = Field(alias="occurredAt")
    source: Literal["runtime", "environment", "grader", "optimizer", "control_plane", "evaluation"]
    type: Literal[
        "run_started", "run_state_changed", "rollout_group_started",
        "attempt_completed", "grader_completed", "reward_composed",
        "optimizer_step_completed", "checkpoint_committed",
        "evaluation_completed", "run_completed", "run_failed", "cleanup_completed",
    ]
    visibility: Literal["policy_visible", "team_visible", "host_private"]
    lineage: RunTelemetryLineage
    attributes: dict[str, str | int | float | bool | None]


class MetricDefinition(ContractModel):
    schema_version: Literal["openpond.metricDefinition.v1"] = Field(alias="schemaVersion")
    id: str = Field(min_length=1, max_length=200)
    display_name: str = Field(alias="displayName", min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=2000)
    value_type: Literal["gauge", "counter", "distribution"] = Field(alias="valueType")
    unit: Literal["ratio", "count", "seconds", "milliseconds", "tokens", "bytes", "usd", "scalar"]
    direction: Literal["higher", "lower", "neutral"]
    aggregation: Literal["last", "sum", "mean", "min", "max", "p50", "p95"]
    visibility: Literal["policy_visible", "team_visible", "host_private"]
    bounded_dimensions: list[str] = Field(alias="boundedDimensions", max_length=32)


class MetricObservation(ContractModel):
    schema_version: Literal["openpond.metricObservation.v1"] = Field(alias="schemaVersion")
    observation_id: str = Field(alias="observationId", min_length=1, max_length=200)
    metric_id: str = Field(alias="metricId", min_length=1, max_length=200)
    event_id: str = Field(alias="eventId", min_length=1, max_length=200)
    sequence: int = Field(ge=0)
    observed_at: datetime = Field(alias="observedAt")
    value: float
    lineage: RunTelemetryLineage
    dimensions: dict[str, str]

    @model_validator(mode="after")
    def validate_core_metric(self) -> "MetricObservation":
        allowed = CORE_METRIC_DIMENSIONS.get(self.metric_id)
        if allowed is None:
            raise ValueError(f"unknown core metric: {self.metric_id}")
        unexpected = set(self.dimensions) - allowed
        if unexpected:
            raise ValueError(f"unsupported metric dimensions: {sorted(unexpected)}")
        if self.metric_id in RATIO_METRICS and not 0 <= self.value <= 1:
            raise ValueError(f"ratio metric {self.metric_id} must be between zero and one")
        return self


class RunTelemetryBatch(ContractModel):
    schema_version: Literal["openpond.runTelemetryBatch.v1"] = Field(alias="schemaVersion")
    events: list[RunTelemetryEvent] = Field(max_length=1000)
    observations: list[MetricObservation] = Field(max_length=10000)

    @model_validator(mode="after")
    def validate_idempotency_keys(self) -> "RunTelemetryBatch":
        if not self.events and not self.observations:
            raise ValueError("telemetry batch cannot be empty")
        keys = [telemetry_idempotency_key(item) for item in [*self.events, *self.observations]]
        if len(keys) != len(set(keys)):
            raise ValueError("telemetry batch contains a duplicate idempotency key")
        return self


class EvidenceReference(ContractModel):
    id: str = Field(min_length=1, max_length=200)
    content_hash: str = Field(alias="contentHash", pattern=r"^[a-f0-9]{64}$")
    kind: Literal["rollout", "attempt", "trace", "grader", "checkpoint", "artifact"]
    visibility: Literal["policy_visible", "team_visible", "host_private"]


def _stable_id(prefix: str, value: dict[str, Any]) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"{prefix}-{hashlib.sha256(canonical).hexdigest()[:32]}"


def telemetry_idempotency_key(item: RunTelemetryEvent | MetricObservation) -> str:
    item_id = item.event_id if isinstance(item, RunTelemetryEvent) else item.observation_id
    return f"{item.lineage.run_id}:{item.sequence}:{item_id}"


class TelemetryBuilder:
    """Constructs ordered, deterministic telemetry for one Run."""

    def __init__(self, lineage: RunTelemetryLineage, starting_sequence: int = 0):
        if starting_sequence < 0:
            raise ValueError("starting_sequence must be nonnegative")
        self.lineage = lineage
        self._sequence = starting_sequence
        self._lock = threading.Lock()

    def _next_sequence(self) -> int:
        with self._lock:
            sequence = self._sequence
            self._sequence += 1
            return sequence

    def event(
        self,
        *,
        occurred_at: datetime,
        source: str,
        event_type: str,
        visibility: str = "team_visible",
        attributes: dict[str, str | int | float | bool | None] | None = None,
        lineage: RunTelemetryLineage | None = None,
    ) -> RunTelemetryEvent:
        event_lineage = lineage or self.lineage
        sequence = self._next_sequence()
        event_id = _stable_id("telemetry", {"runId": event_lineage.run_id, "sequence": sequence, "type": event_type, "source": source})
        return RunTelemetryEvent.model_validate({
            "schemaVersion": "openpond.runTelemetryEvent.v1",
            "eventId": event_id,
            "sequence": sequence,
            "occurredAt": occurred_at,
            "source": source,
            "type": event_type,
            "visibility": visibility,
            "lineage": event_lineage,
            "attributes": attributes or {},
        })

    def observation(
        self,
        *,
        metric_id: str,
        event: RunTelemetryEvent,
        value: float,
        dimensions: dict[str, str] | None = None,
        lineage: RunTelemetryLineage | None = None,
    ) -> MetricObservation:
        observation_lineage = lineage or event.lineage
        sequence = self._next_sequence()
        observation_id = _stable_id("metric", {"runId": observation_lineage.run_id, "metricId": metric_id, "sequence": sequence})
        return MetricObservation.model_validate({
            "schemaVersion": "openpond.metricObservation.v1",
            "observationId": observation_id,
            "metricId": metric_id,
            "eventId": event.event_id,
            "sequence": sequence,
            "observedAt": event.occurred_at,
            "value": value,
            "lineage": observation_lineage,
            "dimensions": dimensions or {},
        })


class BufferedTelemetryEmitter:
    """Buffers portable events and observations; callers control retry policy."""

    def __init__(self, endpoint: str, token: str, batch_size: int = 100, timeout_seconds: int = 15, max_buffer_items: int = 10_000, retry_attempts: int = 3):
        if batch_size < 1 or batch_size > 1000:
            raise ValueError("batch_size must be between 1 and 1000")
        self._endpoint = endpoint
        self._token = token
        self._batch_size = batch_size
        self._timeout_seconds = timeout_seconds
        self._max_buffer_items = max_buffer_items
        self._retry_attempts = retry_attempts
        self._events: list[RunTelemetryEvent] = []
        self._observations: list[MetricObservation] = []
        self._lock = threading.Lock()

    def emit_event(self, event: RunTelemetryEvent) -> None:
        with self._lock:
            if len(self._events) + len(self._observations) >= self._max_buffer_items:
                raise BufferError("telemetry buffer is full")
            self._events.append(event)
            should_flush = len(self._events) + len(self._observations) >= self._batch_size
        if should_flush:
            self.flush()

    def emit_observation(self, observation: MetricObservation) -> None:
        with self._lock:
            if len(self._events) + len(self._observations) >= self._max_buffer_items:
                raise BufferError("telemetry buffer is full")
            self._observations.append(observation)
            should_flush = len(self._events) + len(self._observations) >= self._batch_size
        if should_flush:
            self.flush()

    def flush(self) -> int:
        with self._lock:
            if not self._events and not self._observations:
                return 0
            events, observations = self._events, self._observations
            self._events, self._observations = [], []
        batch = RunTelemetryBatch(
            schemaVersion="openpond.runTelemetryBatch.v1",
            events=events,
            observations=observations,
        )
        body = batch.model_dump_json(by_alias=True).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {self._token}"},
            method="POST",
        )
        last_error: Exception | None = None
        for attempt in range(self._retry_attempts):
            try:
                with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                    json.loads(response.read().decode("utf-8"))
                return len(events) + len(observations)
            except Exception as error:
                last_error = error
                if attempt + 1 < self._retry_attempts:
                    time.sleep(min(2 ** attempt, 4))
        if last_error is not None:
            with self._lock:
                self._events = events + self._events
                self._observations = observations + self._observations
            raise last_error
        return 0

    def close(self) -> int:
        return self.flush()

    def __enter__(self) -> "BufferedTelemetryEmitter":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


class AsyncTelemetryEmitter:
    """Moves HTTP delivery off the trainer hot path and flushes on close."""

    def __init__(self, emitter: BufferedTelemetryEmitter, max_queue_items: int = 10_000):
        self._emitter = emitter
        self._queue: queue.Queue[RunTelemetryEvent | MetricObservation | None] = queue.Queue(maxsize=max_queue_items)
        self._error: Exception | None = None
        self._closed = False
        self._thread = threading.Thread(target=self._run, name="openpond-telemetry", daemon=True)
        self._thread.start()

    def emit_event(self, event: RunTelemetryEvent) -> None:
        self._enqueue(event)

    def emit_observation(self, observation: MetricObservation) -> None:
        self._enqueue(observation)

    def _enqueue(self, item: RunTelemetryEvent | MetricObservation) -> None:
        if self._closed:
            raise RuntimeError("telemetry emitter is closed")
        if self._error is not None:
            raise RuntimeError("telemetry delivery failed") from self._error
        try:
            self._queue.put_nowait(item)
        except queue.Full as error:
            raise BufferError("telemetry delivery queue is full") from error

    def _run(self) -> None:
        try:
            while True:
                item = self._queue.get()
                try:
                    if item is None:
                        self._emitter.flush()
                        return
                    if isinstance(item, RunTelemetryEvent):
                        self._emitter.emit_event(item)
                    else:
                        self._emitter.emit_observation(item)
                finally:
                    self._queue.task_done()
        except Exception as error:
            self._error = error

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.put(None)
        self._thread.join()
        if self._error is not None:
            raise RuntimeError("telemetry delivery failed") from self._error

    def __enter__(self) -> "AsyncTelemetryEmitter":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()
