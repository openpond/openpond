import { once } from "node:events";
import { createServer } from "node:http";
import { BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { expect, test } from "vitest";
import { OpenPondClient } from "../src/index";
import { OpenPondSpanExporter, OpenPondSpanExportError } from "../src/opentelemetry";

const exportBatch = (exporter: OpenPondSpanExporter, spans: ReadableSpan[]) => new Promise<Parameters<Parameters<SpanExporter["export"]>[1]>[0]>(resolve => exporter.export(spans, resolve));

// Failure story: a lost receipt/replayed trace must not duplicate training data,
// and automatic tracing must not leak unrelated prompt/secret attributes.
test("real OTel spans append only explicit projections and preserve replay identity across failures", async () => {
  const requests: { operationId: string; task: { input: unknown; source: unknown } }[] = [];
  let foreignReceipt = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    expect(request.url).toBe("/v1/dataset-workspaces/dataset-one/tasks");
    expect(request.headers.authorization).toBe("Bearer key");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ schemaVersion: "openpond.datasetTaskReceipt.v1", teamId: foreignReceipt ? "foreign" : "team", datasetId: "dataset-one", operationId: body.operationId, taskId: "task", receivedAt: "2026-11-06T16:00:00Z", revision: 1, state: "saved", trainingUseAuthorized: false }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const collector = new InMemorySpanExporter();
  const capture = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: collector })] });
  const tracer = capture.getTracer("test");
  const selected = tracer.startSpan("agent run"); selected.setAttribute("selected", true); selected.setAttribute("secret", "never-upload"); selected.end();
  const ignored = tracer.startSpan("network"); ignored.setAttribute("secret", "never-upload"); ignored.end();
  await capture.forceFlush();
  const spans = collector.getFinishedSpans();
  const exporter = new OpenPondSpanExporter({ client: new OpenPondClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "key", teamId: "team" }), datasetId: "dataset-one", projectSpan: span => span.attributes.selected ? { name: span.name, input: { prompt: "sanitized" } } : null });
  try {
    expect((await exportBatch(exporter, [...spans, spans[0]!])).code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.task.input).toEqual({ prompt: "sanitized" });
    expect(JSON.stringify(requests)).not.toContain("never-upload");
    foreignReceipt = true;
    const failure = await exportBatch(exporter, [spans[0]!]);
    expect(failure.code).toBe(1);
    expect(failure.error).toBeInstanceOf(OpenPondSpanExportError);
    expect(exporter.lastExportError).toBe(failure.error);
    foreignReceipt = false;
    expect((await exportBatch(exporter, [spans[0]!])).code).toBe(0);
    expect(requests[2]).toEqual(requests[0]);
    expect(exporter.lastExportError).toBeUndefined();

    // The standard background processor flushes the actual HTTP exporter before shutdown.
    const provider = new TracerProvider({ spanProcessors: [new BatchSpanProcessor({ exporter, maxQueueSize: 4, maxExportBatchSize: 2 })] });
    const run = provider.getTracer("test-batch").startSpan("agent run"); run.setAttribute("selected", true); run.end();
    await provider.shutdown();
    expect(requests).toHaveLength(4);
    expect((await exportBatch(exporter, [spans[0]!])).code).toBe(1);
  } finally {
    await capture.shutdown();
    await exporter.shutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// Failure story: overfull batches, projection failures, and concurrent flushes
// cannot become unbounded HTTP work or interrupt the application's agent.
test("bounds work and drains accepted writes during shutdown", async () => {
  let release!: () => void;
  let started!: () => void;
  const begin = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const collector = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: collector })] });
  provider.getTracer("test").startSpan("run").end(); await provider.forceFlush();
  const span = collector.getFinishedSpans()[0]!;
  let writes = 0;
  const exporter = new OpenPondSpanExporter({ datasetId: "dataset", maxExportBatchSize: 1,
    projectSpan: () => ({ name: "task", input: {} }), client: { async addTask() {
      writes++; started(); await gate;
      return { schemaVersion: "openpond.datasetTaskReceipt.v1", teamId: "team", datasetId: "dataset", operationId: "operation", taskId: "task", receivedAt: "2026-11-06T16:00:00Z", revision: 1, state: "saved", trainingUseAuthorized: false };
    } },
  });
  expect((await exportBatch(exporter, [span, span])).code).toBe(1);
  expect(writes).toBe(0);
  const pending = exportBatch(exporter, [span]); await begin;
  expect((await exportBatch(exporter, [span])).code).toBe(1);
  let drained = false;
  const shutdown = exporter.shutdown().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  release(); await shutdown;
  expect((await pending).code).toBe(0);
  expect(writes).toBe(1);
  await provider.shutdown();
});
