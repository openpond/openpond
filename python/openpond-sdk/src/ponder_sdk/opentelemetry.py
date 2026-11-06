"""Optional OTel span exporter. Import requires ``ponder-sdk[opentelemetry]``.

No provider, instrumentation, client pool, or worker thread is created here.
Use OTel's BatchSpanProcessor and a synchronous Client with a finite timeout.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from threading import Condition
from time import monotonic

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from .client import Client
from .inputs import DatasetTaskInput


@dataclass(frozen=True)
class SpanExportFailure:
    trace_id: str
    span_id: str
    error: Exception


class OpenPondSpanExportError(Exception):
    def __init__(self, failures: Sequence[SpanExportFailure]):
        self.failures = tuple(failures)
        super().__init__(f"OpenPond could not export {len(failures)} selected span(s).")


class OpenPondSpanExporter(SpanExporter):
    """Project selected finished spans into tasks, using trace/span retry identity.

    ``project_span`` must redact content and return None to skip a span. Nothing
    else from the span is uploaded automatically. Partial failure is returned to
    OTel; successful writes remain safe to replay using their idempotency keys.
    """

    def __init__(self, *, client: Client, dataset_id: str,
                 project_span: Callable[[ReadableSpan], DatasetTaskInput | None],
                 max_export_batch_size: int = 512, export_timeout_millis: int = 25000):
        if not dataset_id.strip():
            raise ValueError("A dataset ID is required.")
        if isinstance(max_export_batch_size, bool) or not isinstance(max_export_batch_size, int) or not 1 <= max_export_batch_size <= 4096:
            raise ValueError("max_export_batch_size must be between 1 and 4096.")
        if isinstance(export_timeout_millis, bool) or not isinstance(export_timeout_millis, int) or not 1 <= export_timeout_millis <= 300000:
            raise ValueError("export_timeout_millis must be between 1 and 300000.")
        self._export_timeout_millis = export_timeout_millis
        self._client = client
        self._dataset_id = dataset_id
        self._project_span = project_span
        self._max_batch_size = max_export_batch_size
        self._condition = Condition()
        self._active = False
        self._closed = False
        self.last_export_error: Exception | None = None

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self._condition:
            if self._closed or self._active or len(spans) > self._max_batch_size:
                self.last_export_error = RuntimeError("OpenPond exporter is closed, busy, or received an oversized batch.")
                return SpanExportResult.FAILURE
            self._active = True
        failures: list[SpanExportFailure] = []
        completed: set[str] = set()
        deadline = monotonic() + self._export_timeout_millis / 1000
        try:
            for span in spans:
                context = span.get_span_context()
                trace_id = f"{context.trace_id:032x}" if context else ""
                span_id = f"{context.span_id:016x}" if context else ""
                event_id = f"{trace_id}:{span_id}"
                if event_id in completed:
                    continue
                try:
                    if monotonic() >= deadline:
                        raise TimeoutError("OpenPond export batch deadline exceeded.")
                    if context is None or not context.is_valid:
                        raise ValueError("A valid OTel span context is required.")
                    task = self._project_span(span)
                    if task is None:
                        continue
                    projected: DatasetTaskInput = {**task, "source": {"kind": "opentelemetry", "eventId": event_id}}
                    self._client.add_task(self._dataset_id, projected, idempotency_key=f"otel:{event_id}")
                    completed.add(event_id)
                except Exception as error:
                    failures.append(SpanExportFailure(trace_id, span_id, error))
            self.last_export_error = OpenPondSpanExportError(failures) if failures else None
            return SpanExportResult.FAILURE if failures else SpanExportResult.SUCCESS
        finally:
            with self._condition:
                self._active = False
                self._condition.notify_all()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        deadline = monotonic() + max(0, timeout_millis) / 1000
        with self._condition:
            while self._active:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
        return True

    def shutdown(self) -> None:
        with self._condition:
            self._closed = True
        if not self.force_flush():
            self.last_export_error = TimeoutError("OpenPond exporter shutdown timed out; keep the client open until export finishes.")
