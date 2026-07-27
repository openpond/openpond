import {
  CorrelatedTelemetryReceiptSchema,
  TelemetrySpanSchema,
  type CorrelatedTelemetryReceipt,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export type PrimeGrpoTelemetrySpan =
  CorrelatedTelemetryReceipt["spans"][number];

export function buildPrimeGrpoTelemetryReceipt(input: {
  modelRunId: string;
  modelVersionId: string;
  groupedReceipt: Record<string, unknown>;
  traceReceipts: unknown[];
  lifecycleSpans: PrimeGrpoTelemetrySpan[];
  provider: {
    resourceId: string;
    gpuType: string;
    gpuCount: number;
    acquiredAt: string;
    releasedAt: string;
    providerReportedUsd: number | null;
    quotedHourlyUsd: number;
  };
  base: {
    profileId: string;
    repository: string;
    revision: string;
  };
  recordedAt: string;
}) {
  const groupedSpans = spans(input.groupedReceipt.timeline);
  const traces = input.traceReceipts
    .map(record)
    .filter((value): value is Record<string, unknown> => value !== null);
  const results = traces
    .map((trace) => record(trace.result))
    .filter((value): value is Record<string, unknown> => value !== null);
  const traceSpans = results.flatMap((result) => spans(result.executionSpans));
  const optimizerReceipts = records(input.groupedReceipt.optimizerReceipts);
  const optimizerSpans = optimizerReceipts.flatMap((receipt) =>
    spans(receipt.spans)
  );
  const samples = results
    .map((result) => record(result.optimizerSample))
    .filter((value): value is Record<string, unknown> => value !== null);
  const promptTokens = samples.reduce(
    (total, sample) => total + nonNegativeInteger(sample.promptTokenCount),
    0
  );
  const generatedTokens = samples.reduce(
    (total, sample) => total + nonNegativeInteger(sample.completionTokenCount),
    0
  );
  const successfulTrajectories = results.filter(
    (result) => result.status === "succeeded" && result.terminal === true
  ).length;
  const failedTrajectories = results.length - successfulTrajectories;
  const optimizerSteps = nonNegativeInteger(
    input.groupedReceipt.optimizerSteps
  );
  const rolloutGroups = records(input.groupedReceipt.batchReceipts).length;
  const gpuSeconds = secondsBetween(
    input.provider.acquiredAt,
    input.provider.releasedAt
  );
  const remoteExecution = input.lifecycleSpans.find(
    (span) => span.name === "remote_execution"
  );
  const workerActiveSeconds = remoteExecution
    ? remoteExecution.durationMs / 1_000
    : null;
  const estimatedUsd = usd(
    (input.provider.quotedHourlyUsd * gpuSeconds) / 3_600
  );
  const trajectoryCount = successfulTrajectories + failedTrajectories;
  const adapterContentHash = adapterHash(optimizerReceipts.at(-1));
  const core = {
    schemaVersion: "openpond.correlatedTelemetryReceipt.v1" as const,
    stage: "training" as const,
    correlation: {
      modelRunId: input.modelRunId,
      modelVersionId: input.modelVersionId,
      policyVersion: nonNegativeInteger(
        input.groupedReceipt.finalPolicyVersion
      ),
      taskId: null,
      rolloutGroupId: null,
      providerResourceId: input.provider.resourceId,
      deploymentId: null,
      inferenceRequestId: null,
    },
    spans: [
      ...input.lifecycleSpans,
      ...groupedSpans,
      ...traceSpans,
      ...optimizerSpans,
    ],
    usage: {
      promptTokens,
      generatedTokens,
      gpuSeconds,
      workerActiveSeconds,
      optimizerSteps,
      rolloutGroups,
      successfulTrajectories,
      failedTrajectories,
      peakGpuMemoryBytes: null,
      peakGpuUtilizationPercent: null,
    },
    resource: {
      provider: "prime",
      resourceIds: [input.provider.resourceId],
      gpuType: input.provider.gpuType,
      gpuCount: input.provider.gpuCount,
      baseProfileId: input.base.profileId,
      baseRepository: input.base.repository,
      baseRevision: input.base.revision,
      adapterContentHash,
    },
    cost: {
      currency: "USD" as const,
      providerReportedUsd: input.provider.providerReportedUsd,
      quotedHourlyUsd: input.provider.quotedHourlyUsd,
      estimatedUsd,
      methodologyVersion: "openpond.primeRawWallClockEstimate.v1",
      pricingInputs: {
        quotedHourlyUsd: input.provider.quotedHourlyUsd,
        observedGpuSeconds: gpuSeconds,
        gpuCount: input.provider.gpuCount,
      },
      unitEstimates: {
        perRolloutUsd:
          trajectoryCount > 0 ? usd(estimatedUsd / trajectoryCount) : 0,
        perOptimizerStepUsd:
          optimizerSteps > 0 ? usd(estimatedUsd / optimizerSteps) : 0,
        perAcceptedModelUsd: estimatedUsd,
      },
    },
    recordedAt: input.recordedAt,
  };
  return CorrelatedTelemetryReceiptSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

function spans(value: unknown): PrimeGrpoTelemetrySpan[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const parsed = TelemetrySpanSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map(record)
    .filter((item): item is Record<string, unknown> => item !== null);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function secondsBetween(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started
  ) {
    throw new Error("prime_grpo_telemetry_provider_window_invalid");
  }
  return (completed - started) / 1_000;
}

function adapterHash(
  receipt: Record<string, unknown> | undefined
): string | null {
  const adapter = record(receipt?.adapter);
  const hash = adapter?.weightsSha256;
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function usd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
