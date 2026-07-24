import {
  TrainingArtifactsSchema,
  TrainingExecutionStatusSchema,
  WorkerEventSchema,
  type TrainingArtifacts,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
  type WorkerEvent,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type {
  SandboxComputeQuote,
  SandboxManagedTrainingClient,
} from "./client.js";

type AuthHeaders = () =>
  | Promise<Record<string, string>>
  | Record<string, string>;

export class SandboxManagedTrainingHttpClient
  implements SandboxManagedTrainingClient
{
  private readonly manifestHashes = new Map<string, string>();
  private readonly inputBundleHashes = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly authHeaders: AuthHeaders,
    private readonly request: typeof fetch = fetch,
  ) {}

  uploadEnvironmentAsset(
    input: Parameters<
      SandboxManagedTrainingClient["uploadEnvironmentAsset"]
    >[0],
  ) {
    return this.json<
      Awaited<
        ReturnType<
          SandboxManagedTrainingClient["uploadEnvironmentAsset"]
        >
      >
    >("/v1/managed-rft/assets", "POST", input);
  }

  uploadHarnessRelease(
    input: Parameters<SandboxManagedTrainingClient["uploadHarnessRelease"]>[0],
  ) {
    return this.json<Awaited<
      ReturnType<SandboxManagedTrainingClient["uploadHarnessRelease"]>
    >>("/v1/managed-rft/releases", "POST", input);
  }

  materialize(
    input: Parameters<SandboxManagedTrainingClient["materialize"]>[0],
  ) {
    return this.json<Awaited<
      ReturnType<SandboxManagedTrainingClient["materialize"]>
    >>("/v1/managed-rft/materializations", "POST", input);
  }

  async quote(
    input: Parameters<SandboxManagedTrainingClient["quote"]>[0],
  ): Promise<SandboxComputeQuote> {
    const result = await this.json<{
      materializationRef: string;
      materializationHash: string;
      quotes: Array<{
        quote: Record<string, unknown>;
        quoteSignature: string;
        imageQualified: boolean;
      }>;
      sideEffectsStarted: false;
    }>("/v1/managed-rft/quotes", "POST", input);
    if (
      result.materializationRef !== input.materializationRef ||
      result.materializationHash !== input.materializationHash
    ) {
      throw new Error(
        "Sandbox quote changed the verified materialization lineage.",
      );
    }
    const selected = result.quotes
      .filter((candidate) => candidate.imageQualified)
      .sort(
        (left, right) => hourlyCost(left.quote) - hourlyCost(right.quote),
      )[0];
    if (!selected) {
      throw new Error("Sandbox returned no qualified connected-GPU quote.");
    }
    const quotedAt =
      typeof selected.quote.quotedAt === "string"
        ? selected.quote.quotedAt
        : new Date().toISOString();
    const expiresAt = new Date(
      new Date(quotedAt).getTime() + 15 * 60_000,
    ).toISOString();
    const base = {
      adapterId: "sandbox-managed",
      estimatedCostUsd: null,
      hourlyCostUsd: hourlyCost(selected.quote),
      expiresAt,
      assumptions: [
        "Exact Sandbox environment materialization",
        "One qualified connected GPU",
        "Provider cost remains bounded by the approved job limits",
      ],
      materializationRef: result.materializationRef,
      materializationHash: result.materializationHash,
      providerQuote: selected.quote,
      quoteSignature: selected.quoteSignature,
    };
    return { ...base, contentHash: contentHash(base) };
  }

  approve(
    input: Parameters<SandboxManagedTrainingClient["approve"]>[0],
  ) {
    return this.json<Awaited<
      ReturnType<SandboxManagedTrainingClient["approve"]>
    >>("/v1/managed-rft/approvals", "POST", {
      manifestHash: input.manifestHash,
      materializationRef: input.materializationRef,
      materializationHash: input.materializationHash,
      quote: input.providerQuote,
      quoteSignature: input.quoteSignature,
      maximumSpendUsd: input.maximumSpendUsd,
      approvalHash: input.approvalHash,
    });
  }

  async launch(
    input: Parameters<SandboxManagedTrainingClient["launch"]>[0],
  ): Promise<TrainingExecutionRef> {
    const inputBundleHash = stringHash(
      object(input.inputBundle).manifestSha256,
      "Sandbox input bundle",
    );
    const result = await this.json<{ job: { id: string } }>(
      "/v1/managed-rft/launches",
      "POST",
      {
        name: input.name,
        idempotencyKey: input.idempotencyKey,
        approvalLeaseRef: input.approvalLeaseRef,
        inputBundle: input.inputBundle,
      },
    );
    this.manifestHashes.set(result.job.id, input.manifestHash);
    this.inputBundleHashes.set(result.job.id, inputBundleHash);
    return {
      runId: input.runId,
      adapterId: "sandbox-managed",
      providerJobId: result.job.id,
      leaseId: null,
      manifestHash: input.manifestHash,
      inputBundleHash,
      createdAt: new Date().toISOString(),
    };
  }

  async status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus> {
    const response = await this.job(ref);
    const job = object(response.job ?? response);
    return TrainingExecutionStatusSchema.parse({
      runId: ref.runId,
      state: mapJobState(job.state),
      phase: String(job.state ?? "unknown"),
      progress:
        typeof job.completedGroups === "number" &&
        typeof job.targetGroups === "number" &&
        job.targetGroups > 0
          ? job.completedGroups / job.targetGroups
          : null,
      updatedAt:
        typeof job.updatedAt === "string"
          ? job.updatedAt
          : new Date().toISOString(),
      errorCode:
        typeof job.terminalReason === "string"
          ? job.terminalReason
          : null,
    });
  }

  async events(
    ref: TrainingExecutionRef,
    afterSequence: number,
  ): Promise<WorkerEvent[]> {
    const jobId = providerJobId(ref);
    const result = await this.json<{ events: unknown[] }>(
      `/v1/managed-rft/jobs/${encodeURIComponent(jobId)}/events`,
      "GET",
    );
    return result.events
      .map((event, sequence) => {
        const record = object(event);
        const payload = { ...record };
        const timestamp = dateString(record.createdAt);
        return WorkerEventSchema.parse({
          sequence,
          runId: ref.runId,
          type: eventType(record),
          timestamp,
          payload,
          payloadHash: contentHash(payload),
        });
      })
      .filter((event) => event.sequence > afterSequence);
  }

  logs(
    ref: TrainingExecutionRef,
    cursor?: string,
  ): ReturnType<SandboxManagedTrainingClient["logs"]> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.json(
      `/v1/managed-rft/jobs/${encodeURIComponent(providerJobId(ref))}/logs${query}`,
      "GET",
    );
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    const response = await this.job(ref);
    const job = object(response.job ?? response);
    await this.json(
      `/v1/managed-rft/jobs/${encodeURIComponent(providerJobId(ref))}/cancel`,
      "POST",
      { expectedVersion: job.version },
    );
  }

  async artifacts(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const result = await this.json<{
      artifacts: unknown[];
      candidateBundle?: unknown;
    }>(
      `/v1/managed-rft/jobs/${encodeURIComponent(providerJobId(ref))}/artifacts`,
      "GET",
    );
    const artifacts = result.artifacts.map((value, index) => {
      const item = object(value);
      return {
        kind: artifactKind(item),
        objectRef: String(item.objectRef ?? item.uri ?? `sandbox://artifact/${index}`),
        sha256:
          typeof item.sha256 === "string"
            ? item.sha256
            : contentHash(item),
        sizeBytes:
          typeof item.sizeBytes === "number" ? item.sizeBytes : 0,
      };
    });
    if (result.candidateBundle) {
      const candidate = object(result.candidateBundle);
      const artifact = object(candidate.artifact);
      artifacts.push({
        kind: "adapter",
        objectRef: String(artifact.uri ?? "sandbox://candidate"),
        sha256:
          typeof artifact.sha256 === "string"
            ? artifact.sha256
            : contentHash(candidate),
        sizeBytes:
          typeof artifact.sizeBytes === "number" ? artifact.sizeBytes : 0,
      });
    }
    const jobId = providerJobId(ref);
    const candidate = object(result.candidateBundle);
    const manifestHash =
      ref.manifestHash ?? this.manifestHashes.get(jobId) ?? null;
    if (!manifestHash) {
      throw new Error(
        "Sandbox artifacts are missing their Harness Run Manifest lineage.",
      );
    }
    if (result.candidateBundle) {
      const inputBundleHash =
        ref.inputBundleHash ??
        this.inputBundleHashes.get(jobId) ??
        null;
      if (!inputBundleHash) {
        throw new Error(
          "Sandbox candidate artifacts are missing their input-bundle lineage.",
        );
      }
      if (candidate.inputManifestSha256 !== inputBundleHash) {
        throw new Error(
          "Sandbox candidate artifacts changed their input-bundle lineage.",
        );
      }
    }
    const base = {
      runId: ref.runId,
      manifestHash,
      artifacts,
    };
    return TrainingArtifactsSchema.parse({
      ...base,
      contentHash: contentHash(base),
    });
  }

  private async job(ref: TrainingExecutionRef): Promise<Record<string, unknown>> {
    const result = await this.json<{ job: Record<string, unknown> }>(
      `/v1/managed-rft/jobs/${encodeURIComponent(providerJobId(ref))}`,
      "GET",
    );
    return result.job;
  }

  private async json<T>(
    pathname: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(
      `${this.baseUrl.replace(/\/$/, "")}${pathname}`,
      {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(await this.authHeaders()),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const record = object(payload);
      throw new Error(
        `Sandbox Managed RFT request failed: ${
          record.message ?? record.error ?? response.status
        }`,
      );
    }
    return payload as T;
  }
}

function providerJobId(ref: TrainingExecutionRef): string {
  if (!ref.providerJobId) {
    throw new Error("Sandbox execution is missing its provider job ID.");
  }
  return ref.providerJobId;
}

function hourlyCost(quote: Record<string, unknown>): number {
  return Number(quote.hourlyUsd ?? 0) + Number(quote.diskHourlyUsd ?? 0);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringHash(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error(`${label} is missing its canonical manifest hash.`);
  }
  return value;
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function mapJobState(value: unknown): TrainingExecutionStatus["state"] {
  const state = String(value ?? "");
  if (state === "completed") return "succeeded";
  if (state === "cancelled") return "cancelled";
  if (state === "cancelling") return "cancelling";
  if (state === "failed" || state === "budget_exhausted") return "failed";
  if (state === "draft" || state === "validating" || state === "admitted") {
    return "queued";
  }
  if (state.startsWith("provisioning") || state === "warming") {
    return "preparing";
  }
  return "running";
}

function eventType(
  value: Record<string, unknown>,
): WorkerEvent["type"] {
  const state = String(value.state ?? "");
  if (state.includes("failed")) return "failure";
  if (state.includes("cancel")) return "cancellation";
  if (state.includes("complete")) return "complete";
  if (String(value.commandType ?? "").includes("checkpoint")) {
    return "checkpoint";
  }
  return "progress";
}

function artifactKind(
  value: Record<string, unknown>,
): TrainingArtifacts["artifacts"][number]["kind"] {
  const kind = String(value.kind ?? value.artifactKind ?? "");
  if (kind.includes("checkpoint")) return "checkpoint";
  if (kind.includes("adapter")) return "adapter";
  if (kind.includes("metric")) return "metrics";
  if (kind.includes("trace") || kind.includes("trajectory")) return "trace";
  if (kind.includes("eval")) return "evaluation";
  return "receipt";
}
