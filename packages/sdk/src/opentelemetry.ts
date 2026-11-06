import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import type { AddTaskOptions, DatasetTaskAppendReceipt, DatasetTaskInput } from "./dataset-task-ingestion.js";

export type OpenPondSpanExporterOptions = {
  client: {
    addTask(datasetId: string, task: DatasetTaskInput, options?: AddTaskOptions): Promise<DatasetTaskAppendReceipt>;
  };
  datasetId: string;
  /** Select useful completed runs and redact content. Return null to skip. */
  projectSpan(span: ReadableSpan): DatasetTaskInput | null | undefined;
  /** Match the BatchSpanProcessor limit. Larger batches fail without uploading. */
  maxExportBatchSize?: number;
  /** Per-task request deadline. Projection must be synchronous and bounded. */
  requestTimeoutMillis?: number;
  /** Overall batch deadline, including all task submissions. */
  exportTimeoutMillis?: number;
};

export type OpenPondSpanFailure = { traceId: string; spanId: string; error: unknown };

export class OpenPondSpanExportError extends Error {
  constructor(readonly failures: readonly OpenPondSpanFailure[]) {
    super(`OpenPond could not export ${failures.length} selected span(s).`);
    this.name = "OpenPondSpanExportError";
  }
}

/**
 * Optional OTel exporter, not an OTLP receiver or automatic instrumentation.
 * Register with BatchSpanProcessor for its bounded background queue. Only the
 * explicit projection is uploaded; no attributes, events, or secrets are copied.
 */
export class OpenPondSpanExporter implements SpanExporter {
  readonly #options: OpenPondSpanExporterOptions;
  readonly #maxBatchSize: number;
  readonly #timeout: number;
  readonly #exportTimeout: number;
  #closed = false;
  #active: Promise<void> | undefined;
  lastExportError: Error | undefined;

  constructor(options: OpenPondSpanExporterOptions) {
    if (!options.datasetId.trim()) throw new Error("A dataset ID is required.");
    this.#maxBatchSize = options.maxExportBatchSize ?? 512;
    this.#timeout = options.requestTimeoutMillis ?? 10_000;
    this.#exportTimeout = options.exportTimeoutMillis ?? 25_000;
    if (!Number.isSafeInteger(this.#maxBatchSize) || this.#maxBatchSize < 1 || this.#maxBatchSize > 4096) throw new Error("maxExportBatchSize must be between 1 and 4096.");
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 300_000) throw new Error("requestTimeoutMillis must be between 1 and 300000.");
    if (!Number.isSafeInteger(this.#exportTimeout) || this.#exportTimeout < 1 || this.#exportTimeout > 300_000) throw new Error("exportTimeoutMillis must be between 1 and 300000.");
    this.#options = { ...options };
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    if (this.#closed || this.#active || spans.length > this.#maxBatchSize) {
      const error = new Error(this.#closed ? "OpenPond exporter is shut down." : this.#active ? "OpenPond exporter already has an active batch." : "OpenPond export batch exceeds its configured limit.");
      this.lastExportError = error;
      resultCallback({ code: 1, error });
      return;
    }
    // Reserve the active slot before user projection executes.
    const operation = Promise.resolve().then(() => this.#exportBatch(spans));
    const settled = operation.then(() => undefined, () => undefined);
    this.#active = settled;
    void operation.then(
      () => { this.lastExportError = undefined; return { code: 0 as const }; },
      (error: Error) => { this.lastExportError = error; return { code: 1 as const, error }; },
    ).then(result => {
      if (this.#active === settled) this.#active = undefined;
      resultCallback(result);
    });
  }

  async #exportBatch(spans: ReadableSpan[]): Promise<void> {
    const failures: OpenPondSpanFailure[] = [];
    const completed = new Set<string>();
    const deadline = performance.now() + this.#exportTimeout;
    for (const span of spans) {
      const { traceId, spanId } = span.spanContext();
      const eventId = `${traceId}:${spanId}`;
      if (completed.has(eventId)) continue;
      try {
        if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId) || /^0+$/.test(traceId) || /^0+$/.test(spanId)) throw new Error("A valid OTel span context is required.");
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new Error("OpenPond export batch deadline exceeded.");
        const task = this.#options.projectSpan(span);
        if (task == null) continue;
        const signal = AbortSignal.timeout(Math.min(this.#timeout, remaining));
        await this.#options.client.addTask(this.#options.datasetId, {
          ...task, source: { kind: "opentelemetry", eventId },
        }, { idempotencyKey: `otel:${eventId}`, signal });
        completed.add(eventId);
      } catch (error) {
        failures.push({ traceId, spanId, error });
      }
    }
    if (failures.length) throw new OpenPondSpanExportError(failures);
  }

  async forceFlush(): Promise<void> { await this.#active; }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.forceFlush();
  }
}
