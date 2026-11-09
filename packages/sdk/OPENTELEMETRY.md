# Optional OpenTelemetry integration

`openpond-sdk/opentelemetry` implements the standard JavaScript
[`SpanExporter`](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-trace.html)
interface. Install the current tracing SDK alongside OpenPond:

```sh
npm install openpond-sdk @opentelemetry/api @opentelemetry/sdk-trace@^3.1.0
```

This is an adapter into the structured [addTask API](./TASK_INGESTION.md), not an
OTLP receiver. Existing automatic instrumentation can produce the spans. Register
this exporter in your existing OTel configuration, alongside your observability
exporter if desired. It does not replace the global provider, install framework
instrumentation, or automatically create training tasks from every log line.

```ts
import { OpenPondClient } from "openpond-sdk";
import { OpenPondSpanExporter } from "openpond-sdk/opentelemetry";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const client = new OpenPondClient({ apiKey, teamId });
const exporter = new OpenPondSpanExporter({
  client,
  datasetId,
  maxExportBatchSize: 32,
  projectSpan(span) {
    // These are application-owned attributes: explicitly mark selected agent runs.
    if (span.attributes["app.learning_task"] !== true) return null;
    const input = span.attributes["app.sanitized_task_input"];
    if (typeof input !== "string" || !input.trim()) return null;
    return {
      name: span.name,
      input: { prompt: input },
      // Preserve for review; upload does not authorize training.
      split: "validation",
    };
  },
});
const processor = new BatchSpanProcessor({
  exporter,
  maxExportBatchSize: 32,
  maxQueueSize: 256,
  exportTimeoutMillis: 30_000,
});
// If your application already has a provider, configure its processor list there.
const provider = new TracerProvider({ spanProcessors: [processor] });
const tracer = provider.getTracer("production-agent");
// Use tracer in your agent, or your existing framework instrumentation.
// At graceful application shutdown:
await provider.shutdown();
// exporter.lastExportError exposes the latest batch failure, if any.
```

Only the returned task and trace/span source IDs are uploaded. Prompts, outputs,
attributes, exceptions and events are not copied implicitly. Redact secrets before
returning content. A selected span should contain the context needed to reproduce
a useful task; logs and exceptions can supply that context through span events in
your projection. Standalone log, metrics and OTLP ingestion are not implemented.
These examples use application attributes, not unsettled GenAI convention names.

The exporter derives a dataset-scoped idempotency key from trace ID and span ID.
Duplicate spans in a successful batch are skipped. Replaying a span after a lost
reply uses the same key. Keep projections deterministic for a span: a changed
payload with an existing key is a conflict, not a second task. Saved tasks still
require the application's separate review and training authorization.

Use `BatchSpanProcessor` for its bounded background queue; ending a span must not
wait for an HTTP write. Queues can drop spans when full. The adapter sends selected
tasks sequentially, rejects oversized/concurrent export batches, and has a 10s
per-request and 25s overall batch deadline by default. Configure small batches for
your network latency. HTTP failures, invalid projections and receipt mismatches
produce OTel export failure with bounded trace/span failure details in
`OpenPondSpanExportError.failures`. No retry worker or persistent outbox is created;
OTel's processor does not guarantee retries or durable delivery. Use direct
`addTask` with your own durable queue when loss is unacceptable.

`forceFlush()` waits for the exporter's current HTTP work; flush the **provider**
to drain its processor queue. `shutdown()` rejects new exports and waits for
accepted work. A successful flush means the queue was drained, not that every
write succeeded: inspect exporter errors/OTel diagnostics. Keep credentials on the
server and do not change providers or close dependencies while exports are active.

Python has the matching optional exporter in `ponder_sdk.opentelemetry`; see the
[Python SDK README](../../python/openpond-sdk/README.md).
