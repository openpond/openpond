import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TrainingArtifactSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
  type GradeResult,
  type TaskAttemptResult,
  type Taskset,
  type TrainingApproval,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  FireworksApiClient,
  resourceId,
  type FireworksRftJob,
  type FireworksSftJob,
} from "./fireworks-client.js";
import {
  normalizeFireworksRftMetrics,
  normalizeFireworksSftMetrics,
} from "./fireworks-metrics.js";
import {
  type FireworksRftEvaluatorProvisioner,
} from "./fireworks-rft-evaluator.js";
import { evaluationDeploymentLeases } from "./fireworks-evaluation-runtime.js";
import {
  errorMessage,
  metadataString,
  stableProviderMetricFingerprint,
} from "./fireworks-provider-utils.js";

const FIREWORKS_MODEL_ALLOWLIST = [
  "accounts/fireworks/models/qwen3-0p6b",
  "accounts/fireworks/models/qwen3-8b",
] as const;
const TERMINAL_JOB_STATES = new Set(["cancelled", "succeeded", "failed"]);
const ACTIVE_RFT_JOB_STATES = new Set<TrainingJob["status"]>([
  "queued",
  "starting",
  "running",
  "cancelling",
  "reconciling",
]);
const TERMINAL_PROVIDER_STATES = new Set([
  "JOB_STATE_COMPLETED",
  "JOB_STATE_EARLY_STOPPED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_DELETED",
]);

export type FireworksProviderCredential = {
  value: string;
  source: "local_secret" | "env";
  createdAt: string;
  updatedAt: string;
};

export type FireworksTrainingValidation = {
  checkedAt: string;
  accountId: string | null;
  modelId: string | null;
  modelMetadataHash: string | null;
  rftSupported: boolean;
  ok: boolean;
  error: string | null;
};

export type FireworksDestinationDeps = {
  store: SqliteStore;
  storeDir: string;
  resolveCredential: () => Promise<FireworksProviderCredential | null>;
  recordCredentialValidation?: (error: string | null) => Promise<void>;
  gradeAttempt?: (input: {
    tasksetId: string;
    taskId: string;
    attempt: TaskAttemptResult;
  }) => Promise<GradeResult>;
  request?: typeof fetch;
  now?: () => Date;
  provisionRftEvaluator?: FireworksRftEvaluatorProvisioner;
  rftPublicBaseUrl?: () => string | null;
};

export class FireworksDestinationBase {
  readonly id = "fireworks" as const;
  private cachedValidation: FireworksTrainingValidation | null = null;
  private validationPromise: Promise<FireworksTrainingValidation> | null = null;

  constructor(protected readonly deps: FireworksDestinationDeps) {}

  protected async recordEvaluationDeploymentLease(input: {
    jobId: string;
    accountId: string;
    deploymentId: string;
    stage: "base" | "trained";
    model: string;
    deployedModelId?: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<void> {
    const job = await this.requireJob(input.jobId);
    const leases = evaluationDeploymentLeases(job).filter(
      (lease) => lease.deploymentId !== input.deploymentId,
    );
    leases.push({
      accountId: input.accountId,
      deploymentId: input.deploymentId,
      stage: input.stage,
      model: input.model,
      deployedModelId: input.deployedModelId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
    await this.deps.store.saveTrainingJob(
      TrainingJobSchema.parse({
        ...job,
        updatedAt: this.timestamp(),
        metadata: {
          ...job.metadata,
          activeEvaluationDeployments: leases,
        },
      }),
    );
  }

  protected async clearEvaluationDeploymentLease(
    jobId: string,
    deploymentId: string,
  ): Promise<void> {
    const job = await this.requireJob(jobId);
    const leases = evaluationDeploymentLeases(job).filter(
      (lease) => lease.deploymentId !== deploymentId,
    );
    await this.deps.store.saveTrainingJob(
      TrainingJobSchema.parse({
        ...job,
        updatedAt: this.timestamp(),
        metadata: {
          ...job.metadata,
          activeEvaluationDeployments: leases,
        },
      }),
    );
  }

  protected async validateProvider(force = false): Promise<FireworksTrainingValidation> {
    if (
      !force &&
      this.cachedValidation &&
      Date.now() - Date.parse(this.cachedValidation.checkedAt) < 60_000
    ) {
      return this.cachedValidation;
    }
    if (this.validationPromise) return this.validationPromise;
    this.validationPromise = this.performProviderValidation().finally(() => {
      this.validationPromise = null;
    });
    return this.validationPromise;
  }

  protected async performProviderValidation(): Promise<FireworksTrainingValidation> {
    const checkedAt = this.timestamp();
    try {
      const credential = await this.requireCredential();
      const client = this.client(credential.value);
      const account = await client.resolveAccount();
      const accountId = resourceId(account.name);
      const modelId = FIREWORKS_MODEL_ALLOWLIST[0];
      const model = await client.model(modelId);
      if (model.state && model.state !== "READY") {
        throw new Error(`Fireworks training model ${modelId} is ${model.state}.`);
      }
      if (!model.tunable || !model.supportsLora) {
        throw new Error(`Fireworks training model ${modelId} is not tunable with LoRA.`);
      }
      const validation = {
        checkedAt,
        accountId,
        modelId,
        modelMetadataHash: contentHash(model),
        rftSupported: model.rlTunable !== false,
        ok: true,
        error: null,
      };
      this.cachedValidation = validation;
      await this.deps.recordCredentialValidation?.(null);
      return validation;
    } catch (error) {
      const message = errorMessage(error);
      const validation = {
        checkedAt,
        accountId: null,
        modelId: null,
        modelMetadataHash: null,
        rftSupported: false,
        ok: false,
        error: message,
      };
      this.cachedValidation = validation;
      await this.deps.recordCredentialValidation?.(message);
      return validation;
    }
  }

  protected async appendEvent(
    job: TrainingJob,
    type: "start" | "progress" | "metric" | "checkpoint" | "cancel" | "complete" | "failure" | "reconcile",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const events = await this.deps.store.listTrainingJobEvents(job.id);
    const sequence = events.length ? Math.max(...events.map((event) => event.sequence)) + 1 : 0;
    await this.deps.store.saveTrainingJobEvent(TrainingJobEventSchema.parse({
      schemaVersion: "openpond.trainingJobEvent.v1",
      id: `fireworks_event_${contentHash([job.id, sequence, type, payload]).slice(0, 24)}`,
      jobId: job.id,
      sequence,
      type,
      timestamp: this.timestamp(),
      payload,
    }));
  }

  protected async recordSftMetrics(
    job: TrainingJob,
    providerJob: FireworksSftJob,
    client: FireworksApiClient,
  ): Promise<void> {
    if (!providerJob.metricsFileSignedUrl) {
      if (
        TERMINAL_JOB_STATES.has(job.status)
        || TERMINAL_PROVIDER_STATES.has(providerJob.state ?? "")
      ) {
        await this.markMetricsCollected(job);
      }
      return;
    }
    try {
      const bytes = await client.download(providerJob.metricsFileSignedUrl);
      const metricsText = bytes.toString("utf8");
      const points = normalizeFireworksSftMetrics(
        metricsText,
        providerJob.updateTime ?? this.timestamp(),
      );
      await this.persistProviderMetricsArtifact(job, {
        filename: "fireworks-sft-metrics.jsonl",
        bytes,
        metricSource: "metrics_file_signed_url",
      });
      await this.appendMetricPoints(job, points, "fireworks_sft");
      await this.markMetricsCollected(job);
    } catch (error) {
      await this.recordMetricsWarning(job, error);
    }
  }

  protected async backfillStoredSftMetrics(job: TrainingJob): Promise<void> {
    if (job.metadata.trainingMethod !== "sft") return;
    const events = await this.deps.store.listTrainingJobEvents(job.id);
    if (events.some((event) =>
      event.type === "metric"
      && event.payload.providerMetricSource === "fireworks_sft"
    )) return;
    const artifact = (await this.deps.store.listTrainingArtifacts(job.id))
      .find((candidate) =>
        candidate.kind === "metrics"
        && candidate.metadata.providerFilename === "fireworks-sft-metrics.jsonl"
      );
    if (!artifact) return;
    const bytes = await readFile(artifact.path);
    if (
      bytes.byteLength !== artifact.sizeBytes
      || sha256(bytes) !== artifact.sha256
    ) {
      throw new Error(
        `Stored Fireworks metrics artifact ${artifact.id} failed integrity verification.`,
      );
    }
    await this.appendMetricPoints(
      job,
      normalizeFireworksSftMetrics(
        bytes.toString("utf8"),
        job.completedAt ?? job.updatedAt,
      ),
      "fireworks_sft",
    );
  }

  protected async recordRftMetrics(
    job: TrainingJob,
    providerJob: FireworksRftJob,
    client: FireworksApiClient,
  ): Promise<void> {
    try {
      const endpointMetrics = await client.rftMetrics(
        metadataString(job, "providerAccountId"),
        metadataString(job, "providerJobId"),
      );
      const artifacts = await this.deps.store.listTrainingArtifacts(job.id);
      const statsArtifact = artifacts.find(
        (artifact) => artifact.metadata.providerFilename === "stats.json",
      );
      const stats = statsArtifact
        ? await readFile(statsArtifact.path, "utf8").catch(() => null)
        : null;
      const metrics = endpointMetrics ?? providerJob.outputMetrics ?? null;
      const points = normalizeFireworksRftMetrics({
        metrics,
        stats,
        fallbackTimestamp:
          providerJob.completedTime ?? providerJob.updateTime ?? this.timestamp(),
      });
      if (metrics != null) {
        const bytes = Buffer.from(
          `${JSON.stringify(metrics, null, 2)}\n`,
          "utf8",
        );
        await this.persistProviderMetricsArtifact(job, {
          filename: "fireworks-rft-metrics.json",
          bytes,
          metricSource: endpointMetrics
            ? "reinforcement_fine_tuning_metrics_endpoint"
            : "job_output_metrics",
        });
      }
      await this.appendMetricPoints(job, points, "fireworks_rft");
      await this.markMetricsCollected(job);
    } catch (error) {
      await this.recordMetricsWarning(job, error);
    }
  }

  protected async appendMetricPoints(
    job: TrainingJob,
    points: ReturnType<typeof normalizeFireworksSftMetrics>,
    source: "fireworks_sft" | "fireworks_rft",
  ): Promise<void> {
    const events = await this.deps.store.listTrainingJobEvents(job.id);
    const fingerprints = new Set(
      events.flatMap((event) =>
        event.type === "metric"
        && event.payload.providerMetricSource === source
          ? [stableProviderMetricFingerprint(source, event.payload)]
          : []),
    );
    for (const point of points) {
      const fingerprint = stableProviderMetricFingerprint(source, point);
      if (fingerprints.has(fingerprint)) continue;
      await this.appendEvent(job, "metric", {
        metricKind: "training_step",
        provider: "fireworks",
        providerMetricSource: source,
        providerMetricFingerprint: fingerprint,
        ...point,
      });
      fingerprints.add(fingerprint);
    }
  }

  protected async persistProviderMetricsArtifact(
    job: TrainingJob,
    input: {
      filename: string;
      bytes: Buffer;
      metricSource: string;
    },
  ): Promise<void> {
    const digest = sha256(input.bytes);
    const existing = (await this.deps.store.listTrainingArtifacts(job.id))
      .find(
        (artifact) =>
          artifact.kind === "metrics"
          && artifact.sha256 === digest
          && artifact.metadata.metricSource === input.metricSource,
      );
    if (existing) return;
    const directory = metadataString(job, "receiptDirectory");
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, input.filename);
    await writeFile(artifactPath, input.bytes);
    const artifact = TrainingArtifactSchema.parse({
      schemaVersion: "openpond.trainingArtifact.v1",
      id: `fireworks_metrics_${contentHash([job.id, input.metricSource]).slice(0, 24)}`,
      jobId: job.id,
      kind: "metrics",
      path: artifactPath,
      sha256: digest,
      sizeBytes: input.bytes.byteLength,
      baseModelId: null,
      baseModelRevision: null,
      tokenizerRevision: null,
      chatTemplateHash: null,
      nonProduction: false,
      createdAt: this.timestamp(),
      metadata: {
        provider: "fireworks",
        metricSource: input.metricSource,
        providerFilename: input.filename,
      },
    });
    await this.deps.store.saveTrainingArtifact(artifact);
  }

  protected async recordMetricsWarning(
    job: TrainingJob,
    error: unknown,
  ): Promise<void> {
    const latest = await this.deps.store.getTrainingJob(job.id) ?? job;
    await this.deps.store.saveTrainingJob(TrainingJobSchema.parse({
      ...latest,
      metadata: {
        ...latest.metadata,
        providerMetricsCollected: false,
        providerMetricsLastError: errorMessage(error),
      },
    }));
  }

  protected async markMetricsCollected(job: TrainingJob): Promise<void> {
    const latest = await this.deps.store.getTrainingJob(job.id) ?? job;
    await this.deps.store.saveTrainingJob(TrainingJobSchema.parse({
      ...latest,
      metadata: {
        ...latest.metadata,
        providerMetricsCollected: true,
        providerMetricsCollectedAt: this.timestamp(),
        providerMetricsLastError: null,
      },
    }));
  }

  protected client(apiKey: string): FireworksApiClient {
    return new FireworksApiClient(apiKey, this.deps.request);
  }

  protected async requireCredential(): Promise<FireworksProviderCredential> {
    const credential = await this.deps.resolveCredential();
    if (!credential?.value.trim()) {
      throw new Error(
        "Fireworks has no saved provider API key. Add it in Settings > Providers; training does not use a second credential store.",
      );
    }
    return credential;
  }

  protected async requireTaskset(id: string): Promise<Taskset> {
    const taskset = await this.deps.store.getTaskset(id);
    if (!taskset) throw new Error("Taskset not found.");
    return taskset;
  }

  protected async assertNoConcurrentRftJob(approvalId: string): Promise<void> {
    const conflicting = (await this.deps.store.listTrainingJobs()).find((job) =>
      job.destinationId === this.id &&
      job.approvalId !== approvalId &&
      ACTIVE_RFT_JOB_STATES.has(job.status) &&
      job.metadata.trainingMethod === "grpo");
    if (conflicting) {
      throw new Error(
        `Fireworks RFT job ${conflicting.id} is still active. Finish or cancel it before launching another RFT job so provider-generated rollout IDs cannot cross-route.`,
      );
    }
  }

  protected async requireJob(id: string): Promise<TrainingJob> {
    const job = await this.deps.store.getTrainingJob(id);
    if (!job || job.destinationId !== this.id) throw new Error("Fireworks training job not found.");
    return job;
  }

  protected assertApproval(plan: TrainingPlan, approval: TrainingApproval): void {
    if (
      approval.planId !== plan.id ||
      approval.destinationId !== this.id ||
      approval.bundleHash.length < 8
    ) {
      throw new Error("Training approval does not match the Fireworks plan.");
    }
  }

  protected timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
