import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  ModelArtifactLineageSchema,
  TaskAttemptResultSchema,
  TrainingArtifactSchema,
  TrainingDestinationCapabilitiesSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
  type GradeResult,
  type TaskAttemptResult,
  type Taskset,
  type TrainingApproval,
  type TrainingArtifact,
  type TrainingCompatibilityReport,
  type TrainingDestinationCapabilities,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import {
  validateTrainingCompatibility,
  type TrainingDestination,
} from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import { resolveCrossSystemTrainTask } from "./cross-system-operations/task-context.js";
import {
  runTrainingTasksetAttempt,
} from "./task-baseline-attempt-runner.js";
import {
  FireworksApiClient,
  fireworksMoneyUsd,
  resourceId,
  type FireworksDeployedModel,
  type FireworksDeployment,
  type FireworksRftJob,
  type FireworksSftJob,
} from "./fireworks-client.js";
import {
  renderFireworksRftDataset,
  renderFireworksSftDataset,
} from "./fireworks-dataset.js";
import {
  normalizeFireworksRftMetrics,
  normalizeFireworksSftMetrics,
} from "./fireworks-metrics.js";
import {
  provisionFireworksRftEvaluator,
  type FireworksRftEvaluatorProvisioner,
  validateFireworksRftPublicBaseUrl,
} from "./fireworks-rft-evaluator.js";

const FIREWORKS_MODEL_ALLOWLIST = [
  "accounts/fireworks/models/qwen3-0p6b",
  "accounts/fireworks/models/qwen3-8b",
] as const;
const FIREWORKS_MAX_DATASET_BYTES = 1_000_000;
const FIREWORKS_MAX_APPROVED_COST_USD = 9.99;
const FIREWORKS_SFT_PRICE_PER_MILLION_TOKENS_USD = 0.5;
const FIREWORKS_CONSERVATIVE_MINIMUM_USD = 3;
const FIREWORKS_MINIMUM_TRAINED_PASS_RATE = 0.75;
const FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN = 0.1;
const FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION =
  "fireworks-dedicated-cross-system-harness-v2";
const FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS = 10 * 60_000;
const FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD = 7;
const FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT = 1;
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

export class FireworksTrainingDestination implements TrainingDestination {
  readonly id = "fireworks" as const;
  private cachedValidation: FireworksTrainingValidation | null = null;
  private validationPromise: Promise<FireworksTrainingValidation> | null = null;
  private readonly collectionPromises = new Map<
    string,
    Promise<TrainingJob>
  >();

  constructor(private readonly deps: {
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
  }) {}

  async capabilities(): Promise<TrainingDestinationCapabilities> {
    const validation = await this.validateProvider();
    return TrainingDestinationCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingDestinationCapabilities.v1",
      destinationId: this.id,
      available: validation.ok,
      methods: ["sft", "grpo"],
      parameterizations: ["lora"],
      modelAllowlist: [...FIREWORKS_MODEL_ALLOWLIST],
      maxDatasetBytes: FIREWORKS_MAX_DATASET_BYTES,
      environmentPlacements: ["provider_native"],
      nonProduction: false,
      unavailableReason: validation.error,
      checkedAt: validation.checkedAt,
    });
  }

  async validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport> {
    const taskset = await this.requireTaskset(plan.tasksetId);
    const compatibility = validateTrainingCompatibility({
      taskset,
      plan,
      capabilities: await this.capabilities(),
    });
    const issues = [...compatibility.issues];
    if (plan.recipe.method === "grpo") {
      const trainExampleCount = taskset.tasks.filter(
        (candidate) => candidate.split === "train",
      ).length;
      const requiredRollouts =
        trainExampleCount * plan.recipe.rollout.groupSize;
      if (plan.recipe.resourceLimits.maxRollouts < requiredRollouts) {
        issues.push({
          code: "fireworks_rft_rollout_budget_too_small",
          severity: "error" as const,
          path: "recipe.resourceLimits.maxRollouts",
          message:
            `Fireworks needs at least ${requiredRollouts} admitted rollouts for `
            + `${trainExampleCount} training examples with group size `
            + `${plan.recipe.rollout.groupSize}; the recipe allows `
            + `${plan.recipe.resourceLimits.maxRollouts}.`,
        });
      }
      if (plan.recipe.reward.environmentId !== "cross-system-operations") {
        issues.push({
          code: "fireworks_rft_environment_unsupported",
          severity: "error" as const,
          path: "recipe.reward.environmentId",
          message: "The first Fireworks RFT path supports only Cross-System Operations.",
        });
      }
      if (plan.recipe.reward.environmentVersion !== CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION) {
        issues.push({
          code: "fireworks_rft_environment_stale",
          severity: "error" as const,
          path: "recipe.reward.environmentVersion",
          message: "The Fireworks RFT environment version does not match the local Cross-System runtime.",
        });
      }
      if (plan.recipe.reward.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) {
        issues.push({
          code: "fireworks_rft_tool_contract_stale",
          severity: "error" as const,
          path: "recipe.reward.toolContractHash",
          message: "The Fireworks RFT tool contract does not match the local Cross-System runtime.",
        });
      }
      if (plan.recipe.reward.graderHash !== contentHash(taskset.graders)) {
        issues.push({
          code: "fireworks_rft_grader_stale",
          severity: "error" as const,
          path: "recipe.reward.graderHash",
          message: "The Fireworks RFT grader hash does not match the immutable Taskset.",
        });
      }
      for (const task of taskset.tasks.filter((candidate) => candidate.split === "train")) {
        try {
          resolveCrossSystemTrainTask(taskset, { rowId: task.id });
        } catch (error) {
          issues.push({
            code: "fireworks_rft_task_unresolvable",
            severity: "error" as const,
            path: `taskset.tasks.${task.id}`,
            message: errorMessage(error),
          });
          break;
        }
      }
    }
    const providerValidation = await this.validateProvider();
    const selectedBaseModelId =
      plan.recipe.method === "sft" || plan.recipe.method === "grpo"
        ? plan.recipe.baseModel.id
        : null;
    if (
      providerValidation.ok &&
      selectedBaseModelId &&
      FIREWORKS_MODEL_ALLOWLIST.includes(
        selectedBaseModelId as (typeof FIREWORKS_MODEL_ALLOWLIST)[number],
      )
    ) {
      try {
        const credential = await this.requireCredential();
        const model = await this.client(credential.value).model(
          selectedBaseModelId,
        );
        if (model.state && model.state !== "READY") {
          throw new Error(
            `Fireworks training model ${selectedBaseModelId} is ${model.state}.`,
          );
        }
        if (!model.tunable || !model.supportsLora) {
          throw new Error(
            `Fireworks training model ${selectedBaseModelId} is not tunable with LoRA.`,
          );
        }
        if (plan.recipe.method === "grpo" && model.rlTunable === false) {
          issues.push({
            code: "fireworks_model_rft_unsupported",
            severity: "error" as const,
            path: "recipe.baseModel",
            message:
              "The selected Fireworks model is not enabled for reinforcement fine-tuning.",
          });
        }
      } catch (error) {
        issues.push({
          code: "fireworks_model_validation_failed",
          severity: "error" as const,
          path: "recipe.baseModel",
          message: errorMessage(error),
        });
      }
    }
    if (!plan.dataPolicy.exportApproved) {
      issues.push({
        code: "fireworks_export_not_approved",
        severity: "error" as const,
        path: "dataPolicy.exportApproved",
        message: "Explicit data export approval is required for Fireworks training.",
      });
    }
    if (
      plan.dataPolicy.retentionDays == null ||
      plan.dataPolicy.retentionDays < 1 ||
      plan.dataPolicy.retentionDays > 30
    ) {
      issues.push({
        code: "fireworks_retention_not_recorded",
        severity: "error" as const,
        path: "dataPolicy.retentionDays",
        message: "Fireworks training requires an explicit provider retention record from 1 through 30 days.",
      });
    }
    const dataset = plan.recipe.method === "grpo"
      ? renderFireworksRftDataset(taskset)
      : renderFireworksSftDataset(taskset);
    if (dataset.bytes.byteLength > FIREWORKS_MAX_DATASET_BYTES) {
      issues.push({
        code: "fireworks_dataset_too_large",
        severity: "error" as const,
        path: "taskset.tasks",
        message: `The rendered Fireworks dataset exceeds ${FIREWORKS_MAX_DATASET_BYTES} bytes.`,
      });
    }
    return {
      ...compatibility,
      compatible: !issues.some((issue) => issue.severity === "error"),
      issues,
      checkedAt: this.timestamp(),
    };
  }

  async quote(plan: TrainingPlan): Promise<{
    estimatedCostUsd: number;
    assumptions: string[];
  }> {
    const taskset = await this.requireTaskset(plan.tasksetId);
    if (plan.recipe.method === "grpo") {
      const dataset = renderFireworksRftDataset(taskset);
      return {
        estimatedCostUsd: FIREWORKS_CONSERVATIVE_MINIMUM_USD,
        assumptions: [
          `Bounded GRPO on ${plan.recipe.baseModel.id}.`,
          `${dataset.exampleCount} train prompts with ${plan.recipe.rollout.groupSize} grouped on-policy rollouts.`,
          "Fireworks currently documents RFT as free for models under 16B; a conservative $3 approval reserve covers independent evaluation inference and pricing changes.",
          "The launch still fails closed above the explicit user maximum.",
        ],
      };
    }
    const dataset = renderFireworksSftDataset(taskset);
    if (plan.recipe.method !== "sft") throw new Error("Fireworks quote requires an executable SFT or GRPO recipe.");
    const billableTokens = dataset.estimatedTokens * Math.max(1, Math.ceil(plan.recipe.optimizer.epochs));
    const tokenEstimate =
      (billableTokens / 1_000_000) * FIREWORKS_SFT_PRICE_PER_MILLION_TOKENS_USD;
    return {
      estimatedCostUsd: Math.max(FIREWORKS_CONSERVATIVE_MINIMUM_USD, tokenEstimate),
      assumptions: [
        "LoRA SFT on a model under 16B parameters.",
        `$${FIREWORKS_SFT_PRICE_PER_MILLION_TOKENS_USD.toFixed(2)} per 1M training tokens.`,
        "A conservative $3 minimum is retained until the provider returns its live estimate.",
        "Inference or deployment used for independent evaluation is accounted separately.",
      ],
    };
  }

  async launch(plan: TrainingPlan, approval: TrainingApproval): Promise<TrainingJob> {
    if (plan.recipe.method === "grpo") return this.launchRft(plan, approval);
    this.assertApproval(plan, approval);
    const compatibility = await this.validate(plan);
    if (!compatibility.compatible) {
      throw new Error(
        `Fireworks Training Plan is incompatible: ${compatibility.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const quote = await this.quote(plan);
    if (
      approval.maximumCostUsd == null ||
      approval.maximumCostUsd <= 0 ||
      approval.maximumCostUsd > FIREWORKS_MAX_APPROVED_COST_USD
    ) {
      throw new Error(
        `Fireworks launch requires an explicit maximum cost from $0.01 to $${FIREWORKS_MAX_APPROVED_COST_USD.toFixed(2)}.`,
      );
    }
    if (quote.estimatedCostUsd > approval.maximumCostUsd) {
      throw new Error(
        `Fireworks estimated cost $${quote.estimatedCostUsd.toFixed(2)} exceeds the approved $${approval.maximumCostUsd.toFixed(2)} maximum.`,
      );
    }

    const validation = await this.validateProvider(true);
    if (!validation.ok || !validation.accountId) {
      throw new Error(validation.error ?? "Fireworks training capability validation failed.");
    }
    const taskset = await this.requireTaskset(plan.tasksetId);
    const bundle = await this.deps.store.findTrainingBundleByPlanAndHash(
      plan.id,
      approval.bundleHash,
    );
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const credential = await this.requireCredential();
    const client = this.client(credential.value);
    const rendered = renderFireworksSftDataset(taskset);
    const accountId = validation.accountId;
    // Provider artifacts include the rendered dataset hash so an exporter
    // compatibility fix can be retried without colliding with a provider job
    // that already failed validation. Identical renders remain idempotent.
    const providerRenderIdentity = `${bundle.contentHash}:${rendered.contentHash}`;
    const datasetId = providerId("op-sft-data", providerRenderIdentity);
    const remoteJobId = providerId("op-sft", `${approval.id}:${rendered.contentHash}`);
    const outputModelId = providerId("op-model", `${approval.id}:${rendered.contentHash}`);
    const receiptDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      remoteJobId,
    );
    await mkdir(receiptDirectory, { recursive: true });
    const datasetPath = path.join(receiptDirectory, "train.fireworks.jsonl");
    await writeFile(datasetPath, rendered.bytes);

    let providerDataset;
    try {
      providerDataset = await client.createDataset({
        accountId,
        datasetId,
        displayName: `OpenPond ${taskset.name}`.slice(0, 63),
        exampleCount: rendered.exampleCount,
      });
      await client.uploadDataset({
        accountId,
        datasetId,
        filename: "train.jsonl",
        bytes: rendered.bytes,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      providerDataset = await client.dataset(accountId, datasetId);
    }
    providerDataset = await waitForDataset(client, accountId, datasetId);

    if (plan.recipe.method !== "sft") throw new Error("Fireworks destination only executes SFT.");
    const timestamp = this.timestamp();
    let job = TrainingJobSchema.parse({
      schemaVersion: "openpond.trainingJob.v1",
      id: `training_job_fireworks_${contentHash([accountId, remoteJobId]).slice(0, 24)}`,
      planId: plan.id,
      bundleHash: bundle.contentHash,
      approvalId: approval.id,
      destinationId: this.id,
      status: "starting",
      nonProduction: false,
      workerPid: null,
      startedAt: timestamp,
      completedAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        provider: "fireworks",
        trainingMethod: "sft",
        providerAccountId: accountId,
        providerDatasetId: datasetId,
        providerDatasetName: providerDataset.name,
        providerDatasetHash: rendered.contentHash,
        providerDatasetExampleCount: rendered.exampleCount,
        providerDatasetTaskIds: rendered.taskIds,
        providerEstimatedTokens: rendered.estimatedTokens,
        providerJobId: remoteJobId,
        providerJobName: null,
        providerJobState: "LOCAL_JOB_RECEIPT_CREATED",
        outputModelId,
        outputModelName: `accounts/${accountId}/models/${outputModelId}`,
        baseModel: plan.recipe.baseModel.id,
        canonicalBundleHash: bundle.contentHash,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        credentialSource: credential.source,
        credentialUpdatedAt: credential.updatedAt,
        trainingCapabilityValidatedAt: validation.checkedAt,
        baseModelProviderMetadataHash: validation.modelMetadataHash,
        approvedMaximumCostUsd: approval.maximumCostUsd,
        quotedCostUsd: quote.estimatedCostUsd,
        providerEstimatedCostUsd: null,
        providerRetentionDays: plan.dataPolicy.retentionDays,
        providerDatasetDeletionStatus: "retained",
        providerArtifactDeletionStatus: "retained",
        receiptDirectory,
      },
    });
    await this.deps.store.saveTrainingJob(job);
    await this.appendEvent(job, "start", {
      stage: "provider_job_create",
      providerJobId: remoteJobId,
      providerDatasetHash: rendered.contentHash,
      canonicalBundleHash: bundle.contentHash,
      approvedMaximumCostUsd: approval.maximumCostUsd,
    });
    let providerJob: FireworksSftJob;
    try {
      providerJob = await client.createSftJob({
        accountId,
        jobId: remoteJobId,
        displayName: `OpenPond ${taskset.name}`.slice(0, 63),
        datasetName: providerDataset.name,
        outputModelId,
        baseModel: plan.recipe.baseModel.id,
        epochs: plan.recipe.optimizer.epochs,
        learningRate: plan.recipe.optimizer.learningRate,
        maxContextLength: plan.recipe.dataset.maxSequenceLength,
        loraRank: plan.recipe.lora.rank,
      });
    } catch (error) {
      if (isConflict(error)) {
        providerJob = await client.sftJob(accountId, remoteJobId);
      } else {
        job = TrainingJobSchema.parse({
          ...job,
          status: "failed",
          completedAt: this.timestamp(),
          updatedAt: this.timestamp(),
          error: errorMessage(error),
        });
        await this.deps.store.saveTrainingJob(job);
        await this.appendEvent(job, "failure", {
          stage: "provider_job_create",
          error: errorMessage(error),
        });
        throw error;
      }
    }
    const providerEstimate = fireworksMoneyUsd(providerJob.estimatedCost);
    if (providerEstimate != null && providerEstimate > approval.maximumCostUsd) {
      await client.cancelSftJob(accountId, remoteJobId).catch(() => undefined);
      throw new Error(
        `Fireworks live estimate $${providerEstimate.toFixed(2)} exceeds the approved $${approval.maximumCostUsd.toFixed(2)} maximum; the job was cancelled.`,
      );
    }

    job = TrainingJobSchema.parse({
      ...job,
      status: providerJobState(providerJob),
      startedAt: providerJob.createTime ?? job.startedAt,
      updatedAt: providerJob.updateTime ?? this.timestamp(),
      metadata: {
        ...job.metadata,
        providerJobName: providerJob.name,
        providerJobState: providerJob.state ?? null,
        outputModelName: providerOutputModel(accountId, providerJob.outputModel, outputModelId),
        providerEstimatedCostUsd: providerEstimate,
      },
    });
    await this.deps.store.saveTrainingJob(job);
    await this.appendEvent(job, "progress", {
      stage: "provider_job_created",
      providerJobId: remoteJobId,
      providerJobState: providerJob.state ?? null,
      providerEstimatedCostUsd: providerEstimate,
    });
    return job;
  }

  async status(jobId: string): Promise<TrainingJob> {
    const job = await this.requireJob(jobId);
    if (job.metadata.trainingMethod === "grpo") return this.statusRft(job);
    if (
      providerTerminalReceiptComplete(job)
    ) {
      await this.backfillStoredSftMetrics(job);
      return await this.deps.store.getTrainingJob(job.id) ?? job;
    }
    const credential = await this.requireCredential();
    const accountId = metadataString(job, "providerAccountId");
    const remoteJobId = metadataString(job, "providerJobId");
    const client = this.client(credential.value);
    const providerJob = await client.sftJob(accountId, remoteJobId);
    let updated = normalizedJob(job, providerJob, this.timestamp());
    const approvedMaximum = metadataNumber(job, "approvedMaximumCostUsd");
    const providerEstimate = fireworksMoneyUsd(providerJob.estimatedCost);
    if (
      providerEstimate != null &&
      approvedMaximum != null &&
      providerEstimate > approvedMaximum &&
      !TERMINAL_PROVIDER_STATES.has(providerJob.state ?? "")
    ) {
      await client.cancelSftJob(accountId, remoteJobId).catch(() => undefined);
      updated = TrainingJobSchema.parse({
        ...updated,
        status: "cancelling",
        error: `Fireworks estimate $${providerEstimate.toFixed(2)} exceeded the approved $${approvedMaximum.toFixed(2)} maximum.`,
        metadata: {
          ...updated.metadata,
          budgetCancellationRequested: true,
          providerEstimatedCostUsd: providerEstimate,
        },
      });
    }
    await this.deps.store.saveTrainingJob(updated);
    await this.recordSftMetrics(updated, providerJob, client);
    updated = await this.deps.store.getTrainingJob(updated.id) ?? updated;
    if (updated.status !== job.status || providerJob.state !== job.metadata.providerJobState) {
      await this.appendEvent(
        updated,
        updated.status === "succeeded"
          ? "complete"
          : updated.status === "failed"
            ? "failure"
            : updated.status === "cancelled"
              ? "cancel"
              : "progress",
        providerProgress(providerJob),
      );
    }
    if (updated.status === "succeeded" && updated.metadata.providerCollected !== true) {
      updated = await this.collectProviderOnce(
        updated.id,
        () => this.collectCompleted(updated, providerJob, credential.value),
      );
    }
    return updated;
  }

  async cancel(jobId: string): Promise<TrainingJob> {
    const job = await this.requireJob(jobId);
    if (TERMINAL_JOB_STATES.has(job.status)) return job;
    const credential = await this.requireCredential();
    if (job.metadata.trainingMethod === "grpo") {
      await this.client(credential.value).cancelRftJob(
        metadataString(job, "providerAccountId"),
        metadataString(job, "providerJobId"),
      );
    } else {
      await this.client(credential.value).cancelSftJob(
        metadataString(job, "providerAccountId"),
        metadataString(job, "providerJobId"),
      );
    }
    const updated = TrainingJobSchema.parse({
      ...job,
      status: "cancelling",
      updatedAt: this.timestamp(),
      metadata: { ...job.metadata, cancellationRequestedAt: this.timestamp() },
    });
    await this.deps.store.saveTrainingJob(updated);
    await this.appendEvent(updated, "cancel", { requested: true });
    return updated;
  }

  async collect(jobId: string): Promise<TrainingArtifact[]> {
    const job = await this.status(jobId);
    if (job.status !== "succeeded") return [];
    return this.deps.store.listTrainingArtifacts(job.id);
  }

  async evaluate(jobId: string): Promise<TrainingArtifact> {
    const job = await this.requireJob(jobId);
    if (job.status !== "succeeded" || job.metadata.providerCollected !== true) {
      throw new Error(
        "Fireworks frozen evaluation is available only after the provider job and artifact import succeed.",
      );
    }
    const plan = await this.deps.store.getTrainingPlan(job.planId);
    if (!plan || (plan.recipe.method !== "sft" && plan.recipe.method !== "grpo")) {
      throw new Error("Fireworks job lost its executable training plan.");
    }
    const taskset = await this.requireTaskset(plan.tasksetId);
    const credential = await this.requireCredential();
    const artifact = await this.evaluateFrozen({
      job,
      plan,
      taskset,
      client: this.client(credential.value),
      baseModel: plan.recipe.baseModel.id,
      trainedModel: metadataString(job, "outputModelName"),
    });
    if (!artifact) {
      throw new Error("No trusted grader is configured for Fireworks frozen evaluation.");
    }
    const thresholdPassed = artifact.metadata.thresholdPassed === true;
    const evaluationComplete = artifact.metadata.evaluationComplete === true;
    const lineages = await this.deps.store.listModelArtifactLineage(taskset.id);
    const lineage = lineages.find((candidate) => candidate.jobId === job.id);
    if (!lineage) {
      throw new Error("Imported Fireworks model lineage was not found.");
    }
    await this.deps.store.saveModelArtifactLineage(
      ModelArtifactLineageSchema.parse({
        ...lineage,
        frozenEvaluationArtifactId: artifact.id,
        promotable:
          thresholdPassed &&
          (plan.recipe.method !== "grpo" ||
            (metadataNumber(job, "optimizerUpdatesObserved") ?? 0) > 0),
      }),
    );
    const latestJob = await this.requireJob(job.id);
    const updated = TrainingJobSchema.parse({
      ...latestJob,
      error: null,
      updatedAt: this.timestamp(),
      metadata: {
        ...latestJob.metadata,
        frozenEvaluationArtifactId: artifact.id,
        frozenEvaluationRuntimeVersion:
          FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
        frozenEvaluationComplete: evaluationComplete,
        frozenEvaluationThresholdPassed: thresholdPassed,
        providerEvaluationEstimatedCostUsd:
          artifact.metadata.cumulativeEvaluationCostUsd ?? null,
        providerTotalEstimatedCostUsd:
          artifact.metadata.cumulativeProviderCostUsd ?? null,
      },
    });
    await this.deps.store.saveTrainingJob(updated);
    await this.appendEvent(updated, "checkpoint", {
      stage: "frozen_evaluation_completed",
      frozenEvaluationArtifactId: artifact.id,
      evaluationComplete,
      thresholdPassed,
      infrastructureFailureCount:
        artifact.metadata.infrastructureFailureCount ?? null,
      estimatedDeploymentCostUsd:
        artifact.metadata.estimatedDeploymentCostUsd ?? null,
    });
    return artifact;
  }

  async reconcile(): Promise<void> {
    const allJobs = (await this.deps.store.listTrainingJobs()).filter(
      (job) => job.destinationId === this.id,
    );
    for (const job of allJobs) {
      if (!providerTerminalReceiptComplete(job)) continue;
      try {
        await this.backfillStoredSftMetrics(job);
      } catch (error) {
        await this.recordMetricsWarning(job, error);
      }
    }
    const expiredEvaluationLeases = allJobs.flatMap((job) =>
      evaluationDeploymentLeases(job)
        .filter((lease) => Date.parse(lease.expiresAt) <= Date.now())
        .map((lease) => ({ job, lease })),
    );
    if (expiredEvaluationLeases.length) {
      try {
        const credential = await this.requireCredential();
        const client = this.client(credential.value);
        for (const { job, lease } of expiredEvaluationLeases) {
          try {
            await unloadEvaluationLoras({
              client,
              accountId: lease.accountId,
              deploymentName:
                `accounts/${lease.accountId}/deployments/${lease.deploymentId}`,
              model: lease.model,
              deployedModelId: lease.deployedModelId,
            });
            await client.deleteDeployment(
              lease.accountId,
              lease.deploymentId,
            );
            await this.clearEvaluationDeploymentLease(
              job.id,
              lease.deploymentId,
            );
          } catch (error) {
            if (/\(404\)/.test(errorMessage(error))) {
              await this.clearEvaluationDeploymentLease(
                job.id,
                lease.deploymentId,
              );
              continue;
            }
            // Retain the durable lease so a later reconcile can retry cleanup.
          }
        }
      } catch {
        // Provider reconciliation below records credential/provider failures.
      }
    }
    const jobs = allJobs.filter(
      (job) =>
        job.destinationId === this.id &&
        !providerTerminalReceiptComplete(job),
    );
    for (const job of jobs) {
      try {
        await this.status(job.id);
      } catch (error) {
        const message = errorMessage(error);
        const latest = await this.deps.store.getTrainingJob(job.id) ?? job;
        const preserveTerminal =
          latest.status === "failed" ||
          latest.status === "cancelled" ||
          latest.metadata.providerCollected === true;
        await this.deps.store.saveTrainingJob(TrainingJobSchema.parse({
          ...latest,
          status: preserveTerminal ? latest.status : "reconciling",
          error: preserveTerminal ? latest.error : message,
          updatedAt: this.timestamp(),
          metadata: { ...latest.metadata, lastReconcileError: message },
        }));
      }
    }
  }

  private async recordEvaluationDeploymentLease(input: {
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

  private async clearEvaluationDeploymentLease(
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

  private async launchRft(
    plan: TrainingPlan,
    approval: TrainingApproval,
  ): Promise<TrainingJob> {
    if (plan.recipe.method !== "grpo") {
      throw new Error("Fireworks RFT launch requires a GRPO recipe.");
    }
    this.assertApproval(plan, approval);
    const compatibility = await this.validate(plan);
    if (!compatibility.compatible) {
      throw new Error(
        `Fireworks RFT plan is incompatible: ${compatibility.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const quote = await this.quote(plan);
    if (
      approval.maximumCostUsd == null ||
      approval.maximumCostUsd <= 0 ||
      approval.maximumCostUsd > FIREWORKS_MAX_APPROVED_COST_USD
    ) {
      throw new Error(
        `Fireworks RFT launch requires an explicit maximum cost from $0.01 to $${FIREWORKS_MAX_APPROVED_COST_USD.toFixed(2)}.`,
      );
    }
    if (quote.estimatedCostUsd > approval.maximumCostUsd) {
      throw new Error(
        `Fireworks RFT estimate $${quote.estimatedCostUsd.toFixed(2)} exceeds the approved $${approval.maximumCostUsd.toFixed(2)} maximum.`,
      );
    }
    const publicBaseUrl =
      this.deps.rftPublicBaseUrl?.() ??
      process.env.OPENPOND_FIREWORKS_RFT_PUBLIC_URL ??
      null;
    if (!publicBaseUrl) {
      throw new Error(
        "Fireworks RFT requires OPENPOND_FIREWORKS_RFT_PUBLIC_URL ending in /v1/training/fireworks/rft.",
      );
    }
    const validatedPublicBaseUrl = validateFireworksRftPublicBaseUrl(publicBaseUrl);
    await this.assertNoConcurrentRftJob(approval.id);
    const validation = await this.validateProvider(true);
    if (!validation.ok || !validation.accountId) {
      throw new Error(validation.error ?? "Fireworks RFT capability validation failed.");
    }
    const taskset = await this.requireTaskset(plan.tasksetId);
    const bundle = await this.deps.store.findTrainingBundleByPlanAndHash(
      plan.id,
      approval.bundleHash,
    );
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const credential = await this.requireCredential();
    const client = this.client(credential.value);
    const rendered = renderFireworksRftDataset(taskset);
    const accountId = validation.accountId;
    const datasetId = providerId("op-rft-data", bundle.contentHash);
    const remoteJobId = providerId("op-rft", approval.id);
    const outputModelId = providerId("op-rft-model", approval.id);
    const receiptDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      remoteJobId,
    );
    await mkdir(receiptDirectory, { recursive: true });
    const datasetPath = path.join(receiptDirectory, "train.fireworks-rft.jsonl");
    await writeFile(datasetPath, rendered.bytes);
    let providerDataset;
    try {
      providerDataset = await client.createDataset({
        accountId,
        datasetId,
        displayName: `OpenPond RFT ${taskset.name}`.slice(0, 63),
        exampleCount: rendered.exampleCount,
      });
      await client.uploadDataset({
        accountId,
        datasetId,
        filename: "train-rft.jsonl",
        bytes: rendered.bytes,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      providerDataset = await client.dataset(accountId, datasetId);
    }
    providerDataset = await waitForDataset(client, accountId, datasetId);
    const provision = this.deps.provisionRftEvaluator ?? provisionFireworksRftEvaluator;
    const evaluator = await provision({
      accountId,
      apiKey: credential.value,
      baseModelId: plan.recipe.baseModel.id,
      publicBaseUrl: validatedPublicBaseUrl,
      directory: path.join(this.deps.storeDir, "training", "fireworks", "evaluators"),
    });
    const timestamp = this.timestamp();
    let job = TrainingJobSchema.parse({
      schemaVersion: "openpond.trainingJob.v1",
      id: `training_job_fireworks_${contentHash([accountId, remoteJobId]).slice(0, 24)}`,
      planId: plan.id,
      bundleHash: bundle.contentHash,
      approvalId: approval.id,
      destinationId: this.id,
      status: "starting",
      nonProduction: false,
      workerPid: null,
      startedAt: timestamp,
      completedAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        provider: "fireworks",
        trainingMethod: "grpo",
        providerAccountId: accountId,
        providerDatasetId: datasetId,
        providerDatasetName: providerDataset.name,
        providerDatasetHash: rendered.contentHash,
        providerDatasetExampleCount: rendered.exampleCount,
        providerDatasetTaskIds: rendered.taskIds,
        providerEstimatedTokens: rendered.estimatedTokens,
        providerEvaluatorId: evaluator.evaluatorId,
        providerEvaluatorName: evaluator.evaluatorName,
        providerEvaluatorSourceHash: evaluator.sourceHash,
        providerRemoteEnvironmentUrl: evaluator.publicBaseUrl,
        providerJobId: remoteJobId,
        providerRunId: remoteJobId,
        providerPolicyModel: plan.recipe.baseModel.id,
        outputModelId,
        outputModelName: `accounts/${accountId}/models/${outputModelId}`,
        baseModel: plan.recipe.baseModel.id,
        canonicalBundleHash: bundle.contentHash,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        credentialSource: credential.source,
        credentialUpdatedAt: credential.updatedAt,
        trainingCapabilityValidatedAt: validation.checkedAt,
        baseModelProviderMetadataHash: validation.modelMetadataHash,
        approvedMaximumCostUsd: approval.maximumCostUsd,
        quotedCostUsd: quote.estimatedCostUsd,
        providerRetentionDays: plan.dataPolicy.retentionDays,
        providerDatasetDeletionStatus: "retained",
        providerArtifactDeletionStatus: "retained",
        receiptDirectory,
        optimizerUpdatesObserved: 0,
      },
    });
    await this.deps.store.saveTrainingJob(job);
    await this.appendEvent(job, "start", {
      stage: "provider_job_create",
      providerJobId: remoteJobId,
      providerDatasetHash: rendered.contentHash,
      providerEvaluatorSourceHash: evaluator.sourceHash,
      canonicalBundleHash: bundle.contentHash,
      approvedMaximumCostUsd: approval.maximumCostUsd,
    });
    let providerJob: FireworksRftJob;
    try {
      providerJob = await client.createRftJob({
        accountId,
        jobId: remoteJobId,
        displayName: `OpenPond RFT ${taskset.name}`.slice(0, 63),
        datasetName: providerDataset.name,
        evaluatorName: evaluator.evaluatorName,
        outputModelId,
        baseModel: plan.recipe.baseModel.id,
        learningRate: plan.recipe.optimizer.learningRate,
        maxContextLength: plan.recipe.dataset.maxPromptTokens,
        loraRank: plan.recipe.lora.rank,
        maxSteps: plan.recipe.optimizer.maxSteps,
        groupSize: plan.recipe.rollout.groupSize,
        maxOutputTokens: plan.recipe.rollout.maxOutputTokens,
        temperature: plan.recipe.rollout.temperature,
        topP: plan.recipe.rollout.topP,
        maxConcurrentRollouts: plan.recipe.rollout.concurrency,
      });
    } catch (error) {
      if (isConflict(error)) {
        providerJob = await client.rftJob(accountId, remoteJobId);
      } else {
        job = TrainingJobSchema.parse({
          ...job,
          status: "failed",
          completedAt: this.timestamp(),
          updatedAt: this.timestamp(),
          error: errorMessage(error),
        });
        await this.deps.store.saveTrainingJob(job);
        await this.appendEvent(job, "failure", {
          stage: "provider_job_create",
          error: errorMessage(error),
        });
        throw error;
      }
    }
    const providerEstimate = fireworksMoneyUsd(providerJob.estimatedCost);
    if (providerEstimate != null && providerEstimate > approval.maximumCostUsd) {
      await client.cancelRftJob(accountId, remoteJobId).catch(() => undefined);
      throw new Error(
        `Fireworks RFT live estimate $${providerEstimate.toFixed(2)} exceeds the approved $${approval.maximumCostUsd.toFixed(2)} maximum; the job was cancelled.`,
      );
    }
    job = normalizedJob(job, providerJob, this.timestamp());
    job = TrainingJobSchema.parse({
      ...job,
      metadata: {
        ...job.metadata,
        providerJobName: providerJob.name,
        providerJobState: providerJob.state ?? null,
        providerExperimentId: providerJob.name,
        providerEstimatedCostUsd: providerEstimate,
        outputModelName: providerOutputModel(
          accountId,
          providerJob.trainingConfig?.outputModel,
          outputModelId,
        ),
        providerRftConfigHash: contentHash({
          trainingConfig: providerJob.trainingConfig,
          inferenceParameters: providerJob.inferenceParameters,
          lossConfig: providerJob.lossConfig,
          maxConcurrentRollouts: providerJob.maxConcurrentRollouts,
        }),
      },
    });
    await this.deps.store.saveTrainingJob(job);
    await this.appendEvent(job, "progress", {
      stage: "provider_job_created",
      ...providerProgress(providerJob),
    });
    return job;
  }

  private async statusRft(job: TrainingJob): Promise<TrainingJob> {
    if (
      providerTerminalReceiptComplete(job)
    ) {
      return job;
    }
    const credential = await this.requireCredential();
    const client = this.client(credential.value);
    const providerJob = await client.rftJob(
      metadataString(job, "providerAccountId"),
      metadataString(job, "providerJobId"),
    );
    let updated = normalizedJob(job, providerJob, this.timestamp());
    const optimizerUpdates = providerOptimizerUpdates(providerJob);
    updated = TrainingJobSchema.parse({
      ...updated,
      metadata: {
        ...updated.metadata,
        optimizerUpdatesObserved: optimizerUpdates,
        providerOutputStats: boundedProviderPayload(providerJob.outputStats),
        providerOutputMetrics: boundedProviderPayload(providerJob.outputMetrics),
      },
    });
    if (updated.status === "succeeded" && optimizerUpdates <= 0) {
      updated = TrainingJobSchema.parse({
        ...updated,
        status: "failed",
        error:
          "Fireworks reported RFT completion without a provider receipt proving optimizer updates.",
      });
    }
    const approvedMaximum = metadataNumber(job, "approvedMaximumCostUsd");
    const providerEstimate = fireworksMoneyUsd(providerJob.estimatedCost);
    if (
      providerEstimate != null &&
      approvedMaximum != null &&
      providerEstimate > approvedMaximum &&
      !TERMINAL_PROVIDER_STATES.has(providerJob.state ?? "")
    ) {
      await client.cancelRftJob(
        metadataString(job, "providerAccountId"),
        metadataString(job, "providerJobId"),
      ).catch(() => undefined);
      updated = TrainingJobSchema.parse({
        ...updated,
        status: "cancelling",
        error: `Fireworks RFT estimate $${providerEstimate.toFixed(2)} exceeded the approved $${approvedMaximum.toFixed(2)} maximum.`,
        metadata: {
          ...updated.metadata,
          budgetCancellationRequested: true,
          providerEstimatedCostUsd: providerEstimate,
        },
      });
    }
    await this.deps.store.saveTrainingJob(updated);
    await this.recordRftMetrics(updated, providerJob, client);
    updated = await this.deps.store.getTrainingJob(updated.id) ?? updated;
    if (updated.status !== job.status || providerJob.state !== job.metadata.providerJobState) {
      await this.appendEvent(
        updated,
        updated.status === "succeeded"
          ? "complete"
          : updated.status === "failed"
            ? "failure"
            : updated.status === "cancelled"
              ? "cancel"
              : "progress",
        {
          ...providerProgress(providerJob),
          optimizerUpdatesObserved: optimizerUpdates,
        },
      );
    }
    if (updated.status === "succeeded" && updated.metadata.providerCollected !== true) {
      updated = await this.collectProviderOnce(
        updated.id,
        () => this.collectCompletedRft(updated, providerJob, credential.value),
      );
    }
    return updated;
  }

  private collectProviderOnce(
    jobId: string,
    collect: () => Promise<TrainingJob>,
  ): Promise<TrainingJob> {
    const existing = this.collectionPromises.get(jobId);
    if (existing) return existing;
    let promise!: Promise<TrainingJob>;
    promise = collect().finally(() => {
      if (this.collectionPromises.get(jobId) === promise) {
        this.collectionPromises.delete(jobId);
      }
    });
    this.collectionPromises.set(jobId, promise);
    return promise;
  }

  private async collectCompletedRft(
    job: TrainingJob,
    providerJob: FireworksRftJob,
    apiKey: string,
  ): Promise<TrainingJob> {
    const existing = await this.deps.store.listTrainingArtifacts(job.id);
    if (job.metadata.providerCollected === true && existing.length) return job;
    const plan = await this.deps.store.getTrainingPlan(job.planId);
    if (!plan || plan.recipe.method !== "grpo") {
      throw new Error("Fireworks job lost its GRPO plan.");
    }
    const optimizerUpdates = providerOptimizerUpdates(providerJob);
    if (optimizerUpdates <= 0) {
      throw new Error(
        "Fireworks reported RFT completion without a provider receipt proving optimizer updates.",
      );
    }
    const taskset = await this.requireTaskset(plan.tasksetId);
    const accountId = metadataString(job, "providerAccountId");
    const outputModelName = metadataString(job, "outputModelName");
    const outputModelId = resourceId(outputModelName);
    const client = this.client(apiKey);
    const outputDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      metadataString(job, "providerJobId"),
      "model",
    );
    await mkdir(outputDirectory, { recursive: true });
    const downloadUrls = await client.modelDownloadUrls(accountId, outputModelId);
    const artifacts: TrainingArtifact[] = [];
    for (const [filename, url] of Object.entries(downloadUrls).sort(([left], [right]) =>
      left.localeCompare(right))) {
      const safeName = safeArtifactName(filename);
      const bytes = await client.download(url);
      const artifactPath = path.join(outputDirectory, safeName);
      await writeFile(artifactPath, bytes);
      const artifact = TrainingArtifactSchema.parse({
        schemaVersion: "openpond.trainingArtifact.v1",
        id: `fireworks_artifact_${contentHash([job.id, filename, sha256(bytes)]).slice(0, 24)}`,
        jobId: job.id,
        kind: artifactKind(safeName),
        path: artifactPath,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        baseModelId: plan.recipe.baseModel.id,
        baseModelRevision: plan.recipe.baseModel.revision,
        tokenizerRevision: plan.recipe.baseModel.tokenizerRevision,
        chatTemplateHash: plan.recipe.baseModel.chatTemplateHash,
        nonProduction: false,
        createdAt: this.timestamp(),
        metadata: {
          provider: "fireworks",
          trainingMethod: "grpo",
          providerFilename: filename,
          providerJobId: metadataString(job, "providerJobId"),
          outputModelName,
          optimizerUpdatesObserved: optimizerUpdates,
        },
      });
      await this.deps.store.saveTrainingArtifact(artifact);
      artifacts.push(artifact);
    }
    if (!artifacts.length) throw new Error("Fireworks RFT returned no downloadable Model files.");
    await this.recordRftMetrics(job, providerJob, client);
    const evaluationArtifact = await this.evaluateFrozen({
      job,
      plan,
      taskset,
      client,
      baseModel: plan.recipe.baseModel.id,
      trainedModel: outputModelName,
    });
    if (evaluationArtifact) artifacts.push(evaluationArtifact);
    const adapterArtifact =
      artifacts.find(
        (artifact) =>
          artifact.kind === "adapter"
          && artifact.metadata.providerFilename === "adapter_model.safetensors",
      ) ??
      artifacts.find((artifact) => artifact.kind === "adapter") ??
      artifacts.find((artifact) => artifact.kind === "checkpoint") ??
      artifacts[0]!;
    const thresholdPassed = evaluationArtifact?.metadata.thresholdPassed === true;
    const evaluationComplete = evaluationArtifact?.metadata.evaluationComplete === true;
    const lineage = ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: `lineage_${adapterArtifact.id}`,
      modelId: plan.modelId,
      artifactId: adapterArtifact.id,
      jobId: job.id,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      graderHash: contentHash(taskset.graders),
      planHash: plan.contentHash,
      bundleHash: job.bundleHash,
      recipeHash: contentHash(plan.recipe),
      workerVersion: "fireworks-managed-api-v1",
      trainerVersion: "fireworks-reinforcementFineTuningJobs-v1",
      importedAt: this.timestamp(),
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
      promotable: thresholdPassed && optimizerUpdates > 0,
      status: "imported",
    });
    await this.deps.store.saveModelArtifactLineage(lineage);
    const updated = TrainingJobSchema.parse({
      ...job,
      status: "succeeded",
      completedAt: providerJob.completedTime ?? job.completedAt ?? this.timestamp(),
      updatedAt: this.timestamp(),
      error: null,
      metadata: {
        ...job.metadata,
        providerCollected: true,
        providerArtifactCount: artifacts.length,
        importedModelLineageId: lineage.id,
        frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
        frozenEvaluationComplete: evaluationComplete,
        frozenEvaluationThresholdPassed: thresholdPassed,
        optimizerUpdatesObserved: optimizerUpdates,
      },
    });
    await this.deps.store.saveTrainingJob(updated);
    await this.appendEvent(updated, "checkpoint", {
      providerArtifactCount: artifacts.length,
      importedModelLineageId: lineage.id,
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
      optimizerUpdatesObserved: optimizerUpdates,
    });
    return updated;
  }

  private async collectCompleted(
    job: TrainingJob,
    providerJob: FireworksSftJob,
    apiKey: string,
  ): Promise<TrainingJob> {
    const existing = await this.deps.store.listTrainingArtifacts(job.id);
    if (job.metadata.providerCollected === true && existing.length) return job;
    const plan = await this.deps.store.getTrainingPlan(job.planId);
    if (!plan || plan.recipe.method !== "sft") throw new Error("Fireworks job lost its SFT plan.");
    const taskset = await this.requireTaskset(plan.tasksetId);
    const accountId = metadataString(job, "providerAccountId");
    const outputModelName = metadataString(job, "outputModelName");
    const outputModelId = resourceId(outputModelName);
    const client = this.client(apiKey);
    const outputDirectory = path.join(
      this.deps.storeDir,
      "training",
      "fireworks",
      metadataString(job, "providerJobId"),
      "model",
    );
    await mkdir(outputDirectory, { recursive: true });
    const downloadUrls = await client.modelDownloadUrls(accountId, outputModelId);
    const artifacts: TrainingArtifact[] = [];
    for (const [filename, url] of Object.entries(downloadUrls).sort(([left], [right]) =>
      left.localeCompare(right))) {
      const safeName = safeArtifactName(filename);
      const bytes = await client.download(url);
      const artifactPath = path.join(outputDirectory, safeName);
      await writeFile(artifactPath, bytes);
      const artifact = TrainingArtifactSchema.parse({
        schemaVersion: "openpond.trainingArtifact.v1",
        id: `fireworks_artifact_${contentHash([job.id, filename, sha256(bytes)]).slice(0, 24)}`,
        jobId: job.id,
        kind: artifactKind(safeName),
        path: artifactPath,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        baseModelId: plan.recipe.baseModel.id,
        baseModelRevision: plan.recipe.baseModel.revision,
        tokenizerRevision: plan.recipe.baseModel.tokenizerRevision,
        chatTemplateHash: plan.recipe.baseModel.chatTemplateHash,
        nonProduction: false,
        createdAt: this.timestamp(),
        metadata: {
          provider: "fireworks",
          providerFilename: filename,
          providerJobId: metadataString(job, "providerJobId"),
          outputModelName,
        },
      });
      await this.deps.store.saveTrainingArtifact(artifact);
      artifacts.push(artifact);
    }
    if (!artifacts.length) throw new Error("Fireworks returned no downloadable Model files.");

    const evaluationArtifact = await this.evaluateFrozen({
      job,
      plan,
      taskset,
      client,
      baseModel: plan.recipe.baseModel.id,
      trainedModel: outputModelName,
    });
    if (evaluationArtifact) artifacts.push(evaluationArtifact);
    const adapterArtifact =
      artifacts.find(
        (artifact) =>
          artifact.kind === "adapter"
          && artifact.metadata.providerFilename === "adapter_model.safetensors",
      ) ??
      artifacts.find((artifact) => artifact.kind === "adapter") ??
      artifacts.find((artifact) => artifact.kind === "checkpoint") ??
      artifacts[0]!;
    const thresholdPassed = evaluationArtifact?.metadata.thresholdPassed === true;
    const evaluationComplete = evaluationArtifact?.metadata.evaluationComplete === true;
    const lineage = ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: `lineage_${adapterArtifact.id}`,
      modelId: plan.modelId,
      artifactId: adapterArtifact.id,
      jobId: job.id,
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      graderHash: contentHash(taskset.graders),
      planHash: plan.contentHash,
      bundleHash: job.bundleHash,
      recipeHash: contentHash(plan.recipe),
      workerVersion: "fireworks-managed-api-v1",
      trainerVersion: "fireworks-supervisedFineTuningJobs-v2",
      importedAt: this.timestamp(),
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
      promotable: thresholdPassed,
      status: "imported",
    });
    await this.deps.store.saveModelArtifactLineage(lineage);
    const updated = TrainingJobSchema.parse({
      ...job,
      status: "succeeded",
      completedAt: providerJob.completedTime ?? job.completedAt ?? this.timestamp(),
      updatedAt: this.timestamp(),
      error: null,
      metadata: {
        ...job.metadata,
        providerCollected: true,
        providerArtifactCount: artifacts.length,
        importedModelLineageId: lineage.id,
        frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
        frozenEvaluationComplete: evaluationComplete,
        frozenEvaluationThresholdPassed: thresholdPassed,
      },
    });
    await this.deps.store.saveTrainingJob(updated);
    await this.appendEvent(updated, "checkpoint", {
      providerArtifactCount: artifacts.length,
      importedModelLineageId: lineage.id,
      frozenEvaluationArtifactId: evaluationArtifact?.id ?? null,
    });
    return updated;
  }

  private async evaluateFrozen(input: {
    job: TrainingJob;
    plan: TrainingPlan;
    taskset: Taskset;
    client: FireworksApiClient;
    baseModel: string;
    trainedModel: string;
  }): Promise<TrainingArtifact | null> {
    const priorArtifactIds = new Set(
      (await this.deps.store.listTrainingArtifacts(input.job.id))
        .filter((artifact) => artifact.kind === "evaluation")
        .map((artifact) => artifact.id),
    );
    return withFireworksEvaluationExecutionLock({
      directory: path.join(
        this.deps.storeDir,
        "training",
        "fireworks",
        metadataString(input.job, "providerJobId"),
      ),
      jobId: input.job.id,
      maxRuntimeMs: FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS,
      execute: () => this.evaluateFrozenUnlocked(input),
      readCompleted: async () => {
        const artifacts = (await this.deps.store.listTrainingArtifacts(input.job.id))
          .filter((artifact) =>
            artifact.kind === "evaluation" &&
            !priorArtifactIds.has(artifact.id))
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt));
        return artifacts[0] ?? null;
      },
    });
  }

  private async evaluateFrozenUnlocked(input: {
    job: TrainingJob;
    plan: TrainingPlan;
    taskset: Taskset;
    client: FireworksApiClient;
    baseModel: string;
    trainedModel: string;
  }): Promise<TrainingArtifact | null> {
    if (!this.deps.gradeAttempt) return null;
    const frozen = input.taskset.tasks.filter((task) => task.split === "frozen_eval");
    const results: Array<{
      taskId: string;
      stage: "base" | "trained";
      attemptId: string;
      gradeId: string;
      passed: boolean;
      score: number | null;
      infrastructureError: string | null;
    }> = [];
    const reusableStages: Array<"base" | "trained"> = [];
    const [persistedAttempts, persistedGrades] = await Promise.all([
      this.deps.store.listTaskAttempts(input.taskset.id),
      this.deps.store.listGradeResultsForTaskset(input.taskset.id),
    ]);
    const gradeByAttempt = new Map(
      persistedGrades.map((grade) => [grade.attemptId, grade]),
    );
    for (const stage of ["base", "trained"] as const) {
      const stageAttempts = persistedAttempts.filter(
        (attempt) =>
          attempt.metadata.jobId === input.job.id &&
          attempt.metadata.evaluationStage === stage &&
          attempt.metadata.evaluationRuntimeVersion ===
            FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
      ).sort((left, right) =>
        left.completedAt.localeCompare(right.completedAt));
      const attemptByTask = new Map(
        stageAttempts.map((attempt) => [attempt.taskId, attempt]),
      );
      const reusable =
        attemptByTask.size === frozen.length &&
        frozen.every((task) => {
          const attempt = attemptByTask.get(task.id);
          return Boolean(
            attempt &&
              attempt.infrastructureError === null &&
              gradeByAttempt.has(attempt.id),
          );
        });
      if (!reusable) continue;
      reusableStages.push(stage);
      for (const task of frozen) {
        const attempt = attemptByTask.get(task.id)!;
        const grade = gradeByAttempt.get(attempt.id)!;
        results.push({
          taskId: task.id,
          stage,
          attemptId: attempt.id,
          gradeId: grade.id,
          passed: grade.passed,
          score: grade.score,
          infrastructureError: null,
        });
      }
    }
    const deployments: FireworksEvaluationDeploymentReceipt[] = [];
    const approvedMaximumCostUsd = metadataNumber(
      input.job,
      "approvedMaximumCostUsd",
    );
    const providerTrainingCostUsd =
      metadataNumber(input.job, "providerEstimatedCostUsd") ?? 0;
    const priorEvaluationArtifacts = (
      await this.deps.store.listTrainingArtifacts(input.job.id)
    ).filter((artifact) => artifact.kind === "evaluation");
    const priorEvaluationCostUsd = priorEvaluationArtifacts
      .reduce(
        (total, artifact) =>
          total +
          (typeof artifact.metadata.estimatedDeploymentCostUsd === "number"
            ? artifact.metadata.estimatedDeploymentCostUsd
            : 0),
        0,
      );
    const unreceiptedEvaluationCostReserveUsd =
      metadataNumber(
        input.job,
        "providerEvaluationUnreceiptedReserveUsd",
      ) ?? 0;
    const nonBillableStartupCorrectionUsd =
      metadataNumber(
        input.job,
        "providerEvaluationNonBillableStartupCorrectionUsd",
      ) ?? 0;
    const evaluationAttemptNumber = priorEvaluationArtifacts.length + 1;
    const evaluationAttemptId = randomUUID();
    const priorDeploymentReceipts = (
      await Promise.all(priorEvaluationArtifacts.map(async (artifact) => {
        try {
          const payload = JSON.parse(await readFile(artifact.path, "utf8")) as {
            deployments?: unknown;
            evaluationAttemptNumber?: unknown;
          };
          return Array.isArray(payload.deployments)
            ? payload.deployments.map((deployment) =>
                deployment &&
                typeof deployment === "object" &&
                !Array.isArray(deployment)
                  ? {
                      ...deployment as Record<string, unknown>,
                      evaluationAttemptNumber:
                        payload.evaluationAttemptNumber,
                    }
                  : deployment)
            : [];
        } catch {
          return [];
        }
      }))
    ).flat();
    if (approvedMaximumCostUsd == null) {
      throw new Error(
        "Fireworks evaluation cannot prove the remaining approved cost boundary.",
      );
    }
    const remainingApprovedCostUsd = Math.max(
      0,
      approvedMaximumCostUsd -
        providerTrainingCostUsd -
        priorEvaluationCostUsd -
        unreceiptedEvaluationCostReserveUsd +
        nonBillableStartupCorrectionUsd,
    );
    const maximumDeploymentCostUsd = Math.min(
      FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS /
        3_600_000 *
        FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD,
      remainingApprovedCostUsd,
    );
    if (maximumDeploymentCostUsd <= 0) {
      throw new Error(
        "Fireworks evaluation has no remaining approved provider budget.",
      );
    }
    const maximumRuntimeMs = Math.min(
      FIREWORKS_FROZEN_EVALUATION_MAX_RUNTIME_MS,
      Math.floor(
        maximumDeploymentCostUsd /
          FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD *
          3_600_000,
      ),
    );
    const deadlineMs = Date.now() + maximumRuntimeMs;
    const accountId = metadataString(input.job, "providerAccountId");
    const maxTokens = Math.min(
      1_024,
      input.plan.recipe.method === "sft"
        ? input.plan.recipe.dataset.maxSequenceLength
        : 1_024,
    );
    const trainedServingMode = selectFireworksTrainedServingMode(
      priorDeploymentReceipts,
      input.job.metadata.fireworksEvaluationServingMode,
    );
    let addonDeploymentShape: string | undefined;
    if (
      !reusableStages.includes("trained") &&
      trainedServingMode === "multi_lora"
    ) {
      try {
        const shapeVersions =
          await input.client.listDeploymentShapeVersions(input.baseModel);
        const desiredAcceleratorType = selectFireworksEvaluationAccelerator(
          priorDeploymentReceipts,
          "trained",
        );
        const compatibleShapes = shapeVersions.filter(
          (version) =>
            version.validated !== false &&
            version.latestValidated === true &&
            version.snapshot?.baseModel === input.baseModel &&
            version.snapshot.precision === "BF16" &&
            version.snapshot.acceleratorCount ===
              FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT &&
            (
              version.snapshot.acceleratorType === "NVIDIA_A100_80GB" ||
              version.snapshot.acceleratorType === "NVIDIA_H100_80GB" ||
              version.snapshot.acceleratorType === "NVIDIA_H200_141GB"
            ) &&
            Boolean(version.snapshot.name),
        );
        const addonShape =
          compatibleShapes.find((version) =>
            version.snapshot?.acceleratorType === desiredAcceleratorType) ??
          compatibleShapes[0];
        addonDeploymentShape = addonShape?.snapshot?.name;
      } catch {
        // A named shape is an optimization, not a requirement. Fireworks also
        // supports explicit one-GPU BF16 deployments with addons enabled.
        addonDeploymentShape = undefined;
      }
    }
    const stageSpecs = ([
      { stage: "base", model: input.baseModel },
      { stage: "trained", model: input.trainedModel },
    ] as const)
      .filter((spec) => !reusableStages.includes(spec.stage))
      .map((spec) => {
        const acceleratorType = selectFireworksEvaluationAccelerator(
          priorDeploymentReceipts,
          spec.stage,
        );
        return {
          ...spec,
          acceleratorType,
          servingMode:
            spec.stage === "trained"
              ? trainedServingMode
              : "direct" as const,
          deploymentBaseModel:
            spec.stage === "trained" &&
            trainedServingMode !== "direct"
              ? input.baseModel
              : spec.model,
          precision:
            acceleratorType === "NVIDIA_A100_80GB" ||
            (
              spec.stage === "trained" &&
              trainedServingMode === "multi_lora"
            )
              ? "BF16" as const
              : undefined,
          enableAddons:
            spec.stage === "trained" && trainedServingMode === "multi_lora",
          enableHotReloadLatestAddon:
            spec.stage === "trained" &&
            trainedServingMode === "hot_reload_lora",
          deploymentShape:
            spec.stage === "trained" && trainedServingMode === "multi_lora"
              ? addonDeploymentShape
              : undefined,
          deploymentId: providerId(
            `op-eval-${spec.stage}`,
            `${input.job.id}:${spec.model}:${FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION}:${evaluationAttemptId}`,
          ),
        };
      });
    let previewError: string | null = null;
    for (const spec of stageSpecs) {
      try {
        const preview = await input.client.createDeployment({
          accountId,
          deploymentId: spec.deploymentId,
          baseModel: spec.deploymentBaseModel,
          displayName:
            spec.stage === "base" ? "OpenPond base eval" : "OpenPond trained eval",
          description:
            "Temporary bounded deployment for OpenPond frozen evaluation.",
          validateOnly: true,
          acceleratorType: spec.acceleratorType,
          precision: spec.precision,
          enableAddons: spec.enableAddons,
          enableHotReloadLatestAddon: spec.enableHotReloadLatestAddon,
          deploymentShape: spec.deploymentShape,
        });
        assertBoundedEvaluationDeployment(preview, {
          requireAddons: spec.enableAddons,
          requireHotReloadAddon: spec.enableHotReloadLatestAddon,
        });
        deployments.push({
          stage: spec.stage,
          deploymentId: spec.deploymentId,
          model: spec.model,
          deploymentBaseModel: spec.deploymentBaseModel,
          servingMode: spec.servingMode,
          validationOnly: true,
          validationState: preview.state ?? null,
          acceleratorCount: preview.acceleratorCount ?? 1,
          acceleratorType: preview.acceleratorType ?? null,
          precision: preview.precision ?? null,
          enableAddons: preview.enableAddons === true,
          enableHotReloadLatestAddon:
            preview.enableHotReloadLatestAddon === true,
          deploymentShape: preview.deploymentShape ?? null,
          createdAt: null,
          readyAt: null,
          deployedModelId: null,
          addonLoadedAt: null,
          addonUnloadedAt: null,
          addonUnloadStatus:
            spec.servingMode !== "direct"
              ? "not_loaded"
              : "not_applicable",
          deletedAt: null,
          deletionStatus: "not_created",
          error: null,
          durationMs: 0,
          estimatedCostUsd: 0,
        });
      } catch (error) {
        previewError = errorMessage(error);
        deployments.push({
          stage: spec.stage,
          deploymentId: spec.deploymentId,
          model: spec.model,
          deploymentBaseModel: spec.deploymentBaseModel,
          servingMode: spec.servingMode,
          validationOnly: true,
          validationState: null,
          acceleratorCount: 0,
          acceleratorType: null,
          precision: spec.precision ?? null,
          enableAddons: spec.enableAddons,
          enableHotReloadLatestAddon:
            spec.enableHotReloadLatestAddon,
          deploymentShape: null,
          createdAt: null,
          readyAt: null,
          deployedModelId: null,
          addonLoadedAt: null,
          addonUnloadedAt: null,
          addonUnloadStatus:
            spec.servingMode !== "direct"
              ? "not_loaded"
              : "not_applicable",
          deletedAt: null,
          deletionStatus: "not_created",
          error: previewError,
          durationMs: 0,
          estimatedCostUsd: 0,
        });
      }
    }

    const persistAttempt = async (
      stage: "base" | "trained",
      model: string,
      task: (typeof frozen)[number],
      attemptInput: TaskAttemptResult,
    ) => {
      const attempt = TaskAttemptResultSchema.parse({
        ...attemptInput,
        modelRef: { providerId: "fireworks", modelId: model },
        metadata: {
          ...attemptInput.metadata,
          jobId: input.job.id,
          providerJobId: metadataString(input.job, "providerJobId"),
          evaluationAttemptId,
          evaluationAttemptNumber,
          evaluationStage: stage,
          sourceOwnedFrozenEvaluation: true,
          evaluationRuntimeVersion:
            FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
        },
      });
      await this.deps.store.deleteGradeResultsForAttempt(attempt.id);
      const grade = await this.deps.gradeAttempt!({
        tasksetId: input.taskset.id,
        taskId: task.id,
        attempt,
      });
      results.push({
        taskId: task.id,
        stage,
        attemptId: attempt.id,
        gradeId: grade.id,
        passed: grade.passed,
        score: grade.score,
        infrastructureError: attempt.infrastructureError,
      });
    };

    const persistInfrastructureStage = async (
      stage: "base" | "trained",
      model: string,
      error: string,
    ) => {
      for (const task of frozen) {
        const timestamp = this.timestamp();
        await persistAttempt(
          stage,
          model,
          task,
          TaskAttemptResultSchema.parse({
            schemaVersion: "openpond.taskAttempt.v1",
            id: frozenEvaluationAttemptId(
              input.job.id,
              stage,
              task.id,
              evaluationAttemptId,
            ),
            tasksetId: input.taskset.id,
            taskId: task.id,
            split: "frozen_eval",
            attempt: 0,
            seed: 17,
            modelRef: { providerId: "fireworks", modelId: model },
            startedAt: timestamp,
            completedAt: timestamp,
            output: {},
            runtimeEventRefs: [],
            artifactRefs: [],
            privilegedOutcomeRef: task.privilegedContextRef,
            infrastructureError: error,
            costUsd: null,
            latencyMs: 0,
            userInterventions: 0,
            metadata: {},
          }),
        );
      }
    };

    if (previewError) {
      for (const spec of stageSpecs) {
        await persistInfrastructureStage(
          spec.stage,
          spec.model,
          `Fireworks deployment validation failed before spend: ${previewError}`,
        );
      }
    } else {
      for (const spec of stageSpecs) {
        const previewReceipt = deployments.find(
          (receipt) => receipt.stage === spec.stage,
        )!;
        const receipt: FireworksEvaluationDeploymentReceipt = {
          ...previewReceipt,
          validationOnly: false,
        };
        deployments.splice(deployments.indexOf(previewReceipt), 1, receipt);
        let stageError: string | null = null;
        let deploymentCreated = false;
        let leaseRecorded = false;
        let leaseCreatedAt: string | null = null;
        const startedMs = Date.now();
        try {
          if (startedMs >= deadlineMs) {
            throw new Error(
              "The bounded Fireworks evaluation runtime expired before deployment.",
            );
          }
          leaseCreatedAt = this.timestamp();
          await this.recordEvaluationDeploymentLease({
            jobId: input.job.id,
            accountId,
            deploymentId: spec.deploymentId,
            stage: spec.stage,
            model: spec.model,
            createdAt: leaseCreatedAt,
            expiresAt: new Date(deadlineMs).toISOString(),
          });
          leaseRecorded = true;
          const deployment = await input.client.createDeployment({
            accountId,
            deploymentId: spec.deploymentId,
            baseModel: spec.deploymentBaseModel,
            displayName:
              spec.stage === "base"
                ? "OpenPond base eval"
                : "OpenPond trained eval",
            description:
              "Temporary bounded deployment for OpenPond frozen evaluation.",
            validateOnly: false,
            acceleratorType: spec.acceleratorType,
            precision: spec.precision,
            enableAddons: spec.enableAddons,
            enableHotReloadLatestAddon:
              spec.enableHotReloadLatestAddon,
            deploymentShape: spec.deploymentShape,
          });
          deploymentCreated = true;
          receipt.createdAt = this.timestamp();
          assertBoundedEvaluationDeployment(deployment, {
            requireAddons: spec.enableAddons,
            requireHotReloadAddon: spec.enableHotReloadLatestAddon,
          });
          await waitForEvaluationDeployment({
            client: input.client,
            accountId,
            deploymentId: spec.deploymentId,
            deadlineMs,
            requireAddons: spec.enableAddons,
            requireHotReloadAddon: spec.enableHotReloadLatestAddon,
          });
          receipt.readyAt = this.timestamp();
          const deploymentName =
            `accounts/${accountId}/deployments/${spec.deploymentId}`;
          if (spec.servingMode !== "direct") {
            const deployedModel = await input.client.loadLora({
              accountId,
              model: spec.model,
              deployment: deploymentName,
              displayName: "OpenPond trained eval LoRA",
              description:
                "Temporary LoRA attachment for OpenPond frozen evaluation.",
              replaceMergedAddon:
                spec.servingMode === "hot_reload_lora",
            });
            const deployedModelId = resourceId(deployedModel.name ?? "");
            if (!deployedModelId) {
              throw new Error(
                "Fireworks loaded the evaluation LoRA without returning a deployed model identifier.",
              );
            }
            receipt.deployedModelId = deployedModelId;
            await this.recordEvaluationDeploymentLease({
              jobId: input.job.id,
              accountId,
              deploymentId: spec.deploymentId,
              stage: spec.stage,
              model: spec.model,
              deployedModelId,
              createdAt: leaseCreatedAt,
              expiresAt: new Date(deadlineMs).toISOString(),
            });
            await waitForEvaluationLora({
              client: input.client,
              accountId,
              deployedModelId,
              deadlineMs,
            });
            receipt.addonLoadedAt = this.timestamp();
          }
          const inferenceModel =
            spec.servingMode !== "direct"
              ? `${spec.model}#${deploymentName}`
              : deploymentName;
          const inferenceDeployment =
            spec.servingMode === "direct" ? deploymentName : undefined;
          for (const task of frozen) {
            const providerUsage: unknown[] = [];
            const attempt = await runTrainingTasksetAttempt({
              store: this.deps.store,
              storeDir: this.deps.storeDir,
              resultId: frozenEvaluationAttemptId(
                input.job.id,
                spec.stage,
                task.id,
                evaluationAttemptId,
              ),
              modelText: async (request) => {
                const completion = await retryFireworksInference(
                  () => input.client.chatCompletion({
                    model: inferenceModel,
                    deployment: inferenceDeployment,
                    messages: request.messages,
                    maxTokens,
                    reasoningEffort: "none",
                  }),
                  deadlineMs,
                );
                providerUsage.push(completion.usage);
                return completion.text;
              },
              crossSystemStream: async function* (request) {
                const completion = await retryFireworksInference(
                  () => input.client.chatCompletionWithTools({
                    model: inferenceModel,
                    deployment: inferenceDeployment,
                    messages: request.messages,
                    tools: request.tools,
                    toolChoice: request.toolChoice,
                    maxTokens,
                    reasoningEffort: "none",
                  }),
                  deadlineMs,
                );
                providerUsage.push(completion.usage);
                yield {
                  text: completion.text,
                  toolCalls: completion.toolCalls,
                };
              },
              attemptInput: {
                tasksetId: input.taskset.id,
                task,
                model: {
                  providerId: "fireworks",
                  modelId: spec.model,
                },
                seed: 17,
                attempt: 0,
              },
            });
            await persistAttempt(
              spec.stage,
              spec.model,
              task,
              TaskAttemptResultSchema.parse({
                ...attempt,
                metadata: {
                  ...attempt.metadata,
                  deploymentId: spec.deploymentId,
                  providerUsage,
                },
              }),
            );
          }
        } catch (error) {
          stageError = errorMessage(error);
          if (!deploymentCreated) {
            try {
              const existing = await input.client.deployment(
                accountId,
                spec.deploymentId,
              );
              deploymentCreated =
                existing.state !== "DELETED" &&
                existing.state !== "DELETING";
              if (deploymentCreated) {
                receipt.createdAt = existing.createTime ?? this.timestamp();
              }
            } catch {
              // The provider confirms no readable deployment for this request.
            }
          }
          const completedTaskIds = new Set(
            results
              .filter((result) => result.stage === spec.stage)
              .map((result) => result.taskId),
          );
          for (const task of frozen.filter(
            (candidate) => !completedTaskIds.has(candidate.id),
          )) {
            const timestamp = this.timestamp();
            await persistAttempt(
              spec.stage,
              spec.model,
              task,
              TaskAttemptResultSchema.parse({
                schemaVersion: "openpond.taskAttempt.v1",
                id: frozenEvaluationAttemptId(
                  input.job.id,
                  spec.stage,
                  task.id,
                  evaluationAttemptId,
                ),
                tasksetId: input.taskset.id,
                taskId: task.id,
                split: "frozen_eval",
                attempt: 0,
                seed: 17,
                modelRef: {
                  providerId: "fireworks",
                  modelId: spec.model,
                },
                startedAt: timestamp,
                completedAt: timestamp,
                output: {},
                runtimeEventRefs: [],
                artifactRefs: [],
                privilegedOutcomeRef: task.privilegedContextRef,
                infrastructureError: stageError,
                costUsd: null,
                latencyMs: 0,
                userInterventions: 0,
                metadata: { deploymentId: spec.deploymentId },
              }),
            );
          }
        } finally {
          if (
            deploymentCreated &&
            spec.servingMode !== "direct"
          ) {
            try {
              const unloadedIds = await unloadEvaluationLoras({
                client: input.client,
                accountId,
                deploymentName:
                  `accounts/${accountId}/deployments/${spec.deploymentId}`,
                model: spec.model,
                deployedModelId: receipt.deployedModelId ?? undefined,
              });
              if (unloadedIds.length) {
                receipt.addonUnloadStatus = "unloaded";
                receipt.addonUnloadedAt = this.timestamp();
              }
            } catch (error) {
              receipt.addonUnloadStatus = "failed";
              const unloadError = errorMessage(error);
              receipt.error = receipt.error
                ? `${receipt.error}; LoRA cleanup: ${unloadError}`
                : unloadError;
            }
          }
          if (deploymentCreated) {
            try {
              await input.client.deleteDeployment(accountId, spec.deploymentId);
              receipt.deletionStatus = "deleted";
              receipt.deletedAt = this.timestamp();
            } catch (error) {
              receipt.deletionStatus = "failed";
              const deletionError = errorMessage(error);
              receipt.error = receipt.error
                ? `${receipt.error}; cleanup: ${deletionError}`
                : deletionError;
            }
          }
          receipt.durationMs = Math.max(0, Date.now() - startedMs);
          const billableStartedMs = receipt.readyAt
            ? Date.parse(receipt.readyAt)
            : Number.NaN;
          const billableEndedMs = receipt.deletedAt
            ? Date.parse(receipt.deletedAt)
            : Date.now();
          receipt.estimatedCostUsd =
            deploymentCreated &&
            Number.isFinite(billableStartedMs)
            ? Math.max(0, billableEndedMs - billableStartedMs) /
              3_600_000 *
              Math.max(1, receipt.acceleratorCount) *
              FIREWORKS_FROZEN_EVALUATION_MAX_GPU_HOURLY_USD
            : 0;
          if (stageError) {
            receipt.error = receipt.error
              ? `${stageError}; cleanup: ${receipt.error}`
              : stageError;
          }
          if (
            leaseRecorded &&
            (
              !deploymentCreated ||
              (
                receipt.deletionStatus === "deleted" &&
                receipt.addonUnloadStatus !== "failed"
              )
            )
          ) {
            await this.clearEvaluationDeploymentLease(
              input.job.id,
              spec.deploymentId,
            );
          }
        }
      }
    }
    const basePassed = results.filter((result) => result.stage === "base" && result.passed).length;
    const trainedPassed = results.filter((result) => result.stage === "trained" && result.passed).length;
    const baseInfrastructureFailures = results.filter(
      (result) => result.stage === "base" && result.infrastructureError !== null,
    ).length;
    const trainedInfrastructureFailures = results.filter(
      (result) => result.stage === "trained" && result.infrastructureError !== null,
    ).length;
    const infrastructureFailureCount =
      baseInfrastructureFailures + trainedInfrastructureFailures;
    const deploymentCleanupComplete = deployments.every(
      (deployment) =>
        (
          deployment.deletionStatus === "deleted" ||
          deployment.deletionStatus === "not_created"
        ) &&
        deployment.addonUnloadStatus !== "failed",
    );
    const estimatedDeploymentCostUsd = deployments.reduce(
      (total, deployment) => total + deployment.estimatedCostUsd,
      0,
    );
    const cumulativeEvaluationCostUsd =
      priorEvaluationCostUsd + estimatedDeploymentCostUsd;
    const receiptedProviderCostUsd =
      providerTrainingCostUsd + cumulativeEvaluationCostUsd;
    const cumulativeProviderCostUsd =
      Math.max(
        0,
        receiptedProviderCostUsd -
          nonBillableStartupCorrectionUsd +
          unreceiptedEvaluationCostReserveUsd,
      );
    const evaluationComplete =
      frozen.length > 0 &&
      infrastructureFailureCount === 0 &&
      deploymentCleanupComplete;
    const basePassRate = frozen.length ? basePassed / frozen.length : 0;
    const trainedPassRate = frozen.length ? trainedPassed / frozen.length : 0;
    const absolutePassRateGain = trainedPassRate - basePassRate;
    const thresholdPassed =
      evaluationComplete &&
      trainedPassRate >= FIREWORKS_MINIMUM_TRAINED_PASS_RATE &&
      absolutePassRateGain >= FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN;
    const summary = {
      basePassed,
      trainedPassed,
      totalPerSubject: frozen.length,
      basePassRate,
      trainedPassRate,
      absolutePassRateGain,
      baseInfrastructureFailures,
      trainedInfrastructureFailures,
      infrastructureFailureCount,
      deploymentCleanupComplete,
      estimatedDeploymentCostUsd,
      priorEvaluationCostUsd,
      unreceiptedEvaluationCostReserveUsd,
      nonBillableStartupCorrectionUsd,
      cumulativeEvaluationCostUsd,
      receiptedProviderCostUsd,
      cumulativeProviderCostUsd,
      maximumDeploymentCostUsd,
      maximumRuntimeMs,
      evaluationComplete,
      thresholdPassed,
    };
    const bytes = Buffer.from(`${JSON.stringify({
      schemaVersion: "openpond.fireworksFrozenEvaluation.v1",
      jobId: input.job.id,
      tasksetId: input.taskset.id,
      tasksetHash: input.taskset.contentHash,
      threshold: {
        minimumTrainedPassRate: FIREWORKS_MINIMUM_TRAINED_PASS_RATE,
        minimumAbsolutePassRateGain: FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN,
      },
      runtimeVersion: FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
      evaluationAttemptId,
      evaluationAttemptNumber,
      reusedStages: reusableStages,
      approvedMaximumCostUsd,
      providerTrainingCostUsd,
      priorEvaluationCostUsd,
      unreceiptedEvaluationCostReserveUsd,
      nonBillableStartupCorrectionUsd,
      maximumDeploymentCostUsd,
      maximumRuntimeMs,
      deployments,
      summary,
      results,
    }, null, 2)}\n`);
    const receiptDirectory = metadataString(input.job, "receiptDirectory");
    const evaluationPath = path.join(
      receiptDirectory,
      `frozen-evaluation-${evaluationAttemptNumber}-${evaluationAttemptId}.json`,
    );
    await writeFile(evaluationPath, bytes);
    const artifact = TrainingArtifactSchema.parse({
      schemaVersion: "openpond.trainingArtifact.v1",
      id: `fireworks_evaluation_${contentHash([input.job.id, sha256(bytes)]).slice(0, 24)}`,
      jobId: input.job.id,
      kind: "evaluation",
      path: evaluationPath,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      baseModelId: executableBaseRecipe(input.plan)?.baseModel.id ?? null,
      baseModelRevision: executableBaseRecipe(input.plan)?.baseModel.revision ?? null,
      tokenizerRevision: executableBaseRecipe(input.plan)?.baseModel.tokenizerRevision ?? null,
      chatTemplateHash: executableBaseRecipe(input.plan)?.baseModel.chatTemplateHash ?? null,
      nonProduction: false,
      createdAt: this.timestamp(),
      metadata: {
        provider: "fireworks",
        sourceOwnedFrozenEvaluation: true,
        evaluationRuntimeVersion:
          FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION,
        evaluationAttemptId,
        evaluationAttemptNumber,
        reusedStages: reusableStages,
        basePassed,
        trainedPassed,
        totalPerSubject: frozen.length,
        basePassRate,
        trainedPassRate,
        absolutePassRateGain,
        baseInfrastructureFailures,
        trainedInfrastructureFailures,
        infrastructureFailureCount,
        deploymentCleanupComplete,
        estimatedDeploymentCostUsd,
        priorEvaluationCostUsd,
        unreceiptedEvaluationCostReserveUsd,
        nonBillableStartupCorrectionUsd,
        cumulativeEvaluationCostUsd,
        receiptedProviderCostUsd,
        cumulativeProviderCostUsd,
        maximumDeploymentCostUsd,
        maximumRuntimeMs,
        evaluationComplete,
        minimumTrainedPassRate: FIREWORKS_MINIMUM_TRAINED_PASS_RATE,
        minimumAbsolutePassRateGain: FIREWORKS_MINIMUM_ABSOLUTE_PASS_RATE_GAIN,
        thresholdPassed,
      },
    });
    await this.deps.store.saveTrainingArtifact(artifact);
    return artifact;
  }

  private async validateProvider(force = false): Promise<FireworksTrainingValidation> {
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

  private async performProviderValidation(): Promise<FireworksTrainingValidation> {
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

  private async appendEvent(
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

  private async recordSftMetrics(
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

  private async backfillStoredSftMetrics(job: TrainingJob): Promise<void> {
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

  private async recordRftMetrics(
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

  private async appendMetricPoints(
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

  private async persistProviderMetricsArtifact(
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

  private async recordMetricsWarning(
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

  private async markMetricsCollected(job: TrainingJob): Promise<void> {
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

  private client(apiKey: string): FireworksApiClient {
    return new FireworksApiClient(apiKey, this.deps.request);
  }

  private async requireCredential(): Promise<FireworksProviderCredential> {
    const credential = await this.deps.resolveCredential();
    if (!credential?.value.trim()) {
      throw new Error(
        "Fireworks has no saved provider API key. Add it in Settings > Providers; training does not use a second credential store.",
      );
    }
    return credential;
  }

  private async requireTaskset(id: string): Promise<Taskset> {
    const taskset = await this.deps.store.getTaskset(id);
    if (!taskset) throw new Error("Taskset not found.");
    return taskset;
  }

  private async assertNoConcurrentRftJob(approvalId: string): Promise<void> {
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

  private async requireJob(id: string): Promise<TrainingJob> {
    const job = await this.deps.store.getTrainingJob(id);
    if (!job || job.destinationId !== this.id) throw new Error("Fireworks training job not found.");
    return job;
  }

  private assertApproval(plan: TrainingPlan, approval: TrainingApproval): void {
    if (
      approval.planId !== plan.id ||
      approval.destinationId !== this.id ||
      approval.bundleHash.length < 8
    ) {
      throw new Error("Training approval does not match the Fireworks plan.");
    }
  }

  private timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function providerTerminalReceiptComplete(job: TrainingJob): boolean {
  if (!TERMINAL_JOB_STATES.has(job.status)) return false;
  if (job.metadata.providerMetricsCollected !== true) return false;
  return job.status !== "succeeded" || job.metadata.providerCollected === true;
}

type FireworksEvaluationDeploymentReceipt = {
  stage: "base" | "trained";
  deploymentId: string;
  model: string;
  deploymentBaseModel: string;
  servingMode: "direct" | "multi_lora" | "hot_reload_lora";
  validationOnly: boolean;
  validationState: string | null;
  acceleratorCount: number;
  acceleratorType: string | null;
  precision: string | null;
  enableAddons: boolean;
  enableHotReloadLatestAddon: boolean;
  deploymentShape: string | null;
  createdAt: string | null;
  readyAt: string | null;
  deployedModelId: string | null;
  addonLoadedAt: string | null;
  addonUnloadedAt: string | null;
  addonUnloadStatus: "not_applicable" | "not_loaded" | "unloaded" | "failed";
  deletedAt: string | null;
  deletionStatus: "not_created" | "deleted" | "failed";
  error: string | null;
  durationMs: number;
  estimatedCostUsd: number;
};

type FireworksEvaluationDeploymentLease = {
  accountId: string;
  deploymentId: string;
  stage: "base" | "trained";
  model?: string;
  deployedModelId?: string;
  createdAt: string;
  expiresAt: string;
};

function evaluationDeploymentLeases(
  job: TrainingJob,
): FireworksEvaluationDeploymentLease[] {
  const raw = job.metadata.activeEvaluationDeployments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.accountId !== "string" ||
      typeof candidate.deploymentId !== "string" ||
      (candidate.stage !== "base" && candidate.stage !== "trained") ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.expiresAt))
    ) {
      return [];
    }
    return [{
      accountId: candidate.accountId,
      deploymentId: candidate.deploymentId,
      stage: candidate.stage,
      model:
        typeof candidate.model === "string" ? candidate.model : undefined,
      deployedModelId:
        typeof candidate.deployedModelId === "string"
          ? candidate.deployedModelId
          : undefined,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
    }];
  });
}

function assertBoundedEvaluationDeployment(
  deployment: FireworksDeployment,
  options: {
    requireAddons?: boolean;
    requireHotReloadAddon?: boolean;
  } = {},
): void {
  if (
    deployment.acceleratorCount !==
    FIREWORKS_FROZEN_EVALUATION_MAX_ACCELERATOR_COUNT
  ) {
    throw new Error(
      `Fireworks deployment validation returned ${deployment.acceleratorCount ?? "unknown"} accelerators; bounded evaluation requires exactly one.`,
    );
  }
  if (
    deployment.minReplicaCount != null &&
    deployment.minReplicaCount !== 1
  ) {
    throw new Error(
      `Fireworks deployment validation returned minReplicaCount=${deployment.minReplicaCount}; bounded evaluation requires one replica.`,
    );
  }
  if (
    deployment.maxReplicaCount != null &&
    deployment.maxReplicaCount !== 1
  ) {
    throw new Error(
      `Fireworks deployment validation returned maxReplicaCount=${deployment.maxReplicaCount}; bounded evaluation requires one replica.`,
    );
  }
  if (deployment.state === "FAILED") {
    throw new Error(
      `Fireworks deployment validation failed: ${deployment.status?.message ?? "unknown provider error"}`,
    );
  }
  if (
    deployment.status?.code &&
    deployment.status.code !== "OK" &&
    deployment.status.code !== "0"
  ) {
    throw new Error(
      `Fireworks deployment reported ${deployment.status.code}: ${deployment.status.message ?? "no provider detail"}`,
    );
  }
  if (
    options.requireAddons &&
    (deployment.precision !== "BF16" || deployment.enableAddons !== true)
  ) {
    throw new Error(
      `Fireworks deployment validation returned precision=${deployment.precision ?? "unknown"} and enableAddons=${String(deployment.enableAddons)}; trained LoRA evaluation requires a BF16 addon deployment.`,
    );
  }
  if (
    options.requireHotReloadAddon &&
    deployment.enableHotReloadLatestAddon !== true
  ) {
    throw new Error(
      "Fireworks deployment validation did not preserve the required hot-reload LoRA merge setting.",
    );
  }
}

async function waitForEvaluationDeployment(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentId: string;
  deadlineMs: number;
  requireAddons?: boolean;
  requireHotReloadAddon?: boolean;
}): Promise<FireworksDeployment> {
  while (true) {
    const deployment = await readEvaluationDeployment(input);
    assertBoundedEvaluationDeployment(deployment, {
      requireAddons: input.requireAddons,
      requireHotReloadAddon: input.requireHotReloadAddon,
    });
    if (deployment.state === "READY") return deployment;
    if (
      deployment.state === "FAILED" ||
      deployment.state === "DELETING" ||
      deployment.state === "DELETED"
    ) {
      throw new Error(
        `Fireworks evaluation deployment ${input.deploymentId} entered ${deployment.state}: ${deployment.status?.message ?? "no provider detail"}`,
      );
    }
    const remainingMs = input.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Fireworks evaluation deployment ${input.deploymentId} did not become ready before the bounded runtime expired.`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2_000, remainingMs)),
    );
  }
}

async function readEvaluationDeployment(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentId: string;
  deadlineMs: number;
}): Promise<FireworksDeployment> {
  try {
    return await input.client.deployment(
      input.accountId,
      input.deploymentId,
    );
  } catch (error) {
    if (!/failed \((404|500|502|503|504)\)/i.test(errorMessage(error))) {
      throw error;
    }
    const deployments = await input.client.listDeployments(input.accountId);
    const deployment = deployments.find(
      (candidate) => resourceId(candidate.name ?? "") === input.deploymentId,
    );
    if (deployment) return deployment;
    return retryFireworksControlPlane(
      () => input.client.deployment(
        input.accountId,
        input.deploymentId,
      ),
      input.deadlineMs,
    );
  }
}

async function waitForEvaluationLora(input: {
  client: FireworksApiClient;
  accountId: string;
  deployedModelId: string;
  deadlineMs: number;
}): Promise<FireworksDeployedModel> {
  while (true) {
    const deployedModel = await retryFireworksControlPlane(
      () => input.client.deployedModel(
        input.accountId,
        input.deployedModelId,
      ),
      input.deadlineMs,
    );
    if (deployedModel.state === "DEPLOYED") return deployedModel;
    if (deployedModel.state === "UNDEPLOYING") {
      throw new Error(
        `Fireworks LoRA ${input.deployedModelId} began unloading before evaluation.`,
      );
    }
    if (
      deployedModel.status?.code &&
      deployedModel.status.code !== "OK" &&
      deployedModel.status.code !== "0"
    ) {
      throw new Error(
        `Fireworks LoRA ${input.deployedModelId} failed to load: ${deployedModel.status.message ?? deployedModel.status.code}`,
      );
    }
    const remainingMs = input.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Fireworks LoRA ${input.deployedModelId} did not become ready before the bounded runtime expired.`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2_000, remainingMs)),
    );
  }
}

async function unloadEvaluationLoras(input: {
  client: FireworksApiClient;
  accountId: string;
  deploymentName: string;
  model?: string;
  deployedModelId?: string;
}): Promise<string[]> {
  let deployedModelIds = input.deployedModelId
    ? [input.deployedModelId]
    : [];
  if (!deployedModelIds.length) {
    const deployedModels = await input.client.listDeployedModels(input.accountId);
    deployedModelIds = deployedModels
      .filter(
        (candidate) =>
          candidate.deployment === input.deploymentName &&
          (!input.model || candidate.model === input.model),
      )
      .map((candidate) => resourceId(candidate.name ?? ""))
      .filter(Boolean);
  }
  const uniqueIds = [...new Set(deployedModelIds)];
  for (const deployedModelId of uniqueIds) {
    try {
      await input.client.unloadLora(input.accountId, deployedModelId);
    } catch (error) {
      if (!/\(404\)/.test(errorMessage(error))) throw error;
    }
  }
  return uniqueIds;
}

async function retryFireworksInference<T>(
  request: () => Promise<T>,
  evaluationDeadlineMs: number,
): Promise<T> {
  const deadlineMs = Math.min(
    evaluationDeadlineMs,
    Date.now() + 60_000,
  );
  while (true) {
    try {
      return await request();
    } catch (error) {
      const message = errorMessage(error);
      if (
        !/failed \((404|503)\)/i.test(message) ||
        Date.now() >= deadlineMs
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, deadlineMs - Date.now())),
      );
    }
  }
}

async function retryFireworksControlPlane<T>(
  request: () => Promise<T>,
  evaluationDeadlineMs: number,
): Promise<T> {
  const deadlineMs = Math.min(
    evaluationDeadlineMs,
    Date.now() + 60_000,
  );
  while (true) {
    try {
      return await request();
    } catch (error) {
      const message = errorMessage(error);
      if (
        !/failed \((404|500|502|503|504)\)/i.test(message) ||
        Date.now() >= deadlineMs
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, deadlineMs - Date.now())),
      );
    }
  }
}

function frozenEvaluationAttemptId(
  jobId: string,
  stage: "base" | "trained",
  taskId: string,
  evaluationAttemptId: string,
): string {
  return `attempt_${contentHash([
    jobId,
    stage,
    taskId,
    evaluationAttemptId,
  ]).slice(0, 24)}`;
}

function providerId(prefix: string, source: string): string {
  return `${prefix}-${contentHash(source).slice(0, 24)}`.slice(0, 63);
}

function providerOutputModel(
  accountId: string,
  providerValue: string | undefined,
  fallbackId: string,
): string {
  if (providerValue?.startsWith("accounts/")) return providerValue;
  return `accounts/${accountId}/models/${providerValue || fallbackId}`;
}

type FireworksManagedJob = FireworksSftJob | FireworksRftJob;

function providerJobState(job: FireworksManagedJob): TrainingJob["status"] {
  switch (job.state) {
    case "JOB_STATE_COMPLETED":
    case "JOB_STATE_EARLY_STOPPED":
      return "succeeded";
    case "JOB_STATE_FAILED":
    case "JOB_STATE_EXPIRED":
    case "JOB_STATE_DELETED":
      return "failed";
    case "JOB_STATE_CANCELLED":
      return "cancelled";
    case "JOB_STATE_CANCELLING":
    case "JOB_STATE_DELETING":
    case "JOB_STATE_DELETING_CLEANING_UP":
      return "cancelling";
    case "JOB_STATE_RUNNING":
    case "JOB_STATE_WRITING_RESULTS":
      return "running";
    case "JOB_STATE_CREATING":
    case "JOB_STATE_CREATING_INPUT_DATASET":
    case "JOB_STATE_VALIDATING":
    case "JOB_STATE_PENDING":
    case "JOB_STATE_RE_QUEUEING":
    case "JOB_STATE_IDLE":
    case "JOB_STATE_PAUSED":
    default:
      return "starting";
  }
}

function normalizedJob(
  job: TrainingJob,
  providerJob: FireworksManagedJob,
  timestamp: string,
): TrainingJob {
  const status = providerJobState(providerJob);
  const providerError =
    status === "failed"
      ? providerJob.status?.message || `Fireworks job ended as ${providerJob.state ?? "unknown"}.`
      : null;
  return TrainingJobSchema.parse({
    ...job,
    status,
    completedAt: TERMINAL_JOB_STATES.has(status)
      ? providerJob.completedTime ?? timestamp
      : null,
    error: providerError,
    updatedAt: providerJob.updateTime ?? timestamp,
    metadata: {
      ...job.metadata,
      providerJobName: providerJob.name,
      providerJobState: providerJob.state ?? null,
      providerEstimatedCostUsd: fireworksMoneyUsd(providerJob.estimatedCost),
      providerProgress: providerProgress(providerJob),
    },
  });
}

function providerProgress(job: FireworksManagedJob): Record<string, unknown> {
  return {
    providerJobState: job.state ?? null,
    percent: job.jobProgress?.percent ?? null,
    epoch: job.jobProgress?.epoch ?? null,
    inputTokens: job.jobProgress?.inputTokens ?? null,
    outputTokens: job.jobProgress?.outputTokens ?? null,
    totalInputRequests: job.jobProgress?.totalInputRequests ?? null,
    totalProcessedRequests: job.jobProgress?.totalProcessedRequests ?? null,
    successfullyProcessedRequests: job.jobProgress?.successfullyProcessedRequests ?? null,
    failedRequests: job.jobProgress?.failedRequests ?? null,
    providerEstimatedCostUsd: fireworksMoneyUsd(job.estimatedCost),
  };
}

export function providerOptimizerUpdates(job: FireworksRftJob): number {
  const candidates = [
    findNumericMetric(job.outputMetrics, ["optimizerSteps", "optimizer_steps", "steps"]),
    findNumericMetric(job.outputStats, ["optimizerSteps", "optimizer_steps", "steps"]),
    providerCheckpointUpdates(job),
  ].filter((value): value is number => value != null);
  return candidates.length ? Math.max(0, Math.trunc(Math.max(...candidates))) : 0;
}

function providerCheckpointUpdates(job: FireworksRftJob): number {
  if (!job.outputMetrics) return 0;
  let payload: unknown;
  try {
    payload = JSON.parse(job.outputMetrics) as unknown;
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const epochs = (payload as Record<string, unknown>).epoch_to_evaluation_output;
  if (!epochs || typeof epochs !== "object" || Array.isArray(epochs)) return 0;
  const baseModel = job.trainingConfig?.baseModel;
  return Object.values(epochs as Record<string, unknown>).filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const epoch = value as Record<string, unknown>;
    const checkpoint = epoch.checkpoint_gcs_path;
    const outputModel = epoch.output_model;
    const targetModules = epoch.target_modules;
    return (
      typeof checkpoint === "string" &&
      checkpoint.trim().length > 0 &&
      typeof outputModel === "string" &&
      outputModel.trim().length > 0 &&
      outputModel !== baseModel &&
      Array.isArray(targetModules) &&
      targetModules.some((item) => typeof item === "string" && item.length > 0)
    );
  }).length;
}

function findNumericMetric(value: string | undefined, keys: string[]): number | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return findNumericMetricInValue(parsed, new Set(keys), 0);
  } catch {
    for (const key of keys) {
      const match = new RegExp(`${key}[^0-9]{0,8}([0-9]+)`, "i").exec(value);
      if (match) return Number(match[1]);
    }
    return null;
  }
}

function findNumericMetricInValue(
  value: unknown,
  keys: Set<string>,
  depth: number,
): number | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericMetricInValue(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && typeof item === "number" && Number.isFinite(item)) return item;
    const found = findNumericMetricInValue(item, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function boundedProviderPayload(value: string | undefined): string | null {
  return value?.slice(0, 100_000) ?? null;
}

export async function withFireworksEvaluationExecutionLock<T>(input: {
  directory: string;
  jobId: string;
  maxRuntimeMs: number;
  execute: () => Promise<T>;
  readCompleted: () => Promise<T | null>;
}): Promise<T> {
  await mkdir(input.directory, { recursive: true });
  const lockPath = path.join(
    input.directory,
    `.frozen-evaluation-${contentHash(input.jobId).slice(0, 16)}.lock`,
  );
  const joinDeadlineMs = Date.now() + input.maxRuntimeMs + 60_000;
  while (true) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(joinDeadlineMs).toISOString(),
        }), "utf8");
      } finally {
        await handle.close();
      }
      try {
        return await input.execute();
      } finally {
        try {
          const lease = JSON.parse(await readFile(lockPath, "utf8")) as {
            token?: unknown;
          };
          if (lease.token === token) await unlink(lockPath);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }

    while (true) {
      const lease = await readEvaluationExecutionLease(lockPath);
      if (!lease) break;
      const expired = Date.parse(lease.expiresAt) <= Date.now();
      const ownerAlive = processIsAlive(lease.pid);
      if (expired || !ownerAlive) {
        await unlink(lockPath).catch((error) => {
          if (!isMissingFileError(error)) throw error;
        });
        break;
      }
      if (Date.now() >= joinDeadlineMs) {
        throw new Error(
          `Timed out waiting for the in-progress frozen evaluation for ${input.jobId}.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const completed = await input.readCompleted();
    if (completed != null) return completed;
  }
}

export function selectFireworksEvaluationAccelerator(
  priorDeployments: unknown[],
  stage: "base" | "trained",
): "NVIDIA_A100_80GB" | "NVIDIA_H100_80GB" {
  const stageDeployments = priorDeployments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const deployment = value as Record<string, unknown>;
    return deployment.stage === stage ? [deployment] : [];
  });
  const latestSuccessfulDeployment = [...stageDeployments]
    .filter((deployment) =>
      typeof deployment.readyAt === "string" &&
      !deployment.error &&
      (
        deployment.acceleratorType === "NVIDIA_A100_80GB" ||
        deployment.acceleratorType === "NVIDIA_H100_80GB"
      ))
    .sort((left, right) =>
      Number(right.evaluationAttemptNumber ?? 0) -
      Number(left.evaluationAttemptNumber ?? 0))[0];
  if (
    latestSuccessfulDeployment?.acceleratorType === "NVIDIA_A100_80GB" ||
    latestSuccessfulDeployment?.acceleratorType === "NVIDIA_H100_80GB"
  ) {
    return latestSuccessfulDeployment.acceleratorType;
  }
  const stageFailures = priorDeployments.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const deployment = value as Record<string, unknown>;
    return (
      deployment.stage === stage &&
      typeof deployment.error === "string"
    )
      ? [deployment]
      : [];
  });
  const latestFailure = [...stageFailures].sort((left, right) =>
    Number(right.evaluationAttemptNumber ?? 0) -
    Number(left.evaluationAttemptNumber ?? 0))[0];
  if (
    latestFailure?.acceleratorType === "NVIDIA_A100_80GB" &&
    /internal error|initializing model server/i.test(
      String(latestFailure.error),
    )
  ) {
    return "NVIDIA_H100_80GB";
  }
  if (
    latestFailure?.acceleratorType === "NVIDIA_H100_80GB" &&
    /internal error|initializing model server/i.test(
      String(latestFailure.error),
    ) &&
    stageFailures.some((deployment) =>
      deployment.acceleratorType === "NVIDIA_A100_80GB" &&
      /internal error|initializing model server/i.test(
        String(deployment.error),
      ))
  ) {
    return "NVIDIA_H100_80GB";
  }
  const h100CapacityFailures = priorDeployments.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const deployment = value as Record<string, unknown>;
    return (
      deployment.stage === stage &&
      deployment.acceleratorType === "NVIDIA_H100_80GB" &&
      typeof deployment.error === "string" &&
      /RESOURCE_EXHAUSTED|no available capacity/i.test(deployment.error)
    );
  }).length;
  return h100CapacityFailures >= 2
    ? "NVIDIA_A100_80GB"
    : "NVIDIA_H100_80GB";
}

export function selectFireworksTrainedServingMode(
  priorDeployments: unknown[],
  configuredMode: unknown,
): "direct" | "hot_reload_lora" | "multi_lora" {
  if (configuredMode === "multi_lora") return "multi_lora";
  const latestSuccessfulMode = priorDeployments
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const deployment = value as Record<string, unknown>;
      return (
        deployment.stage === "trained" &&
        typeof deployment.readyAt === "string" &&
        !deployment.error &&
        (
          deployment.servingMode === "direct" ||
          deployment.servingMode === "hot_reload_lora" ||
          deployment.servingMode === "multi_lora"
        )
      )
        ? [deployment]
        : [];
    })
    .sort((left, right) =>
      Number(right.evaluationAttemptNumber ?? 0) -
      Number(left.evaluationAttemptNumber ?? 0))[0];
  if (
    latestSuccessfulMode?.servingMode === "direct" ||
    latestSuccessfulMode?.servingMode === "hot_reload_lora" ||
    latestSuccessfulMode?.servingMode === "multi_lora"
  ) {
    return latestSuccessfulMode.servingMode;
  }
  const latestFailure = priorDeployments
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const deployment = value as Record<string, unknown>;
      return (
        deployment.stage === "trained" &&
        typeof deployment.servingMode === "string" &&
        typeof deployment.error === "string"
      )
        ? [deployment]
        : [];
    })
    .sort((left, right) =>
      Number(right.evaluationAttemptNumber ?? 0) -
      Number(left.evaluationAttemptNumber ?? 0))[0];
  const directInternalFailure = priorDeployments.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const deployment = value as Record<string, unknown>;
    return (
      deployment.stage === "trained" &&
      deployment.servingMode === "direct" &&
      typeof deployment.error === "string" &&
      /internal error|live.?merge|deployment/i.test(deployment.error)
    );
  });
  if (
    latestFailure?.servingMode === "multi_lora" &&
    /internal error|addon|lora/i.test(String(latestFailure.error))
  ) {
    if (
      directInternalFailure &&
      latestFailure.acceleratorType === "NVIDIA_H100_80GB"
    ) {
      return "hot_reload_lora";
    }
    return directInternalFailure ? "multi_lora" : "direct";
  }
  if (
    latestFailure?.servingMode === "direct" &&
    /internal error|live.?merge|deployment/i.test(String(latestFailure.error))
  ) {
    return "multi_lora";
  }
  if (
    latestFailure?.servingMode === "hot_reload_lora" &&
    /internal error|hot.?reload|addon/i.test(String(latestFailure.error))
  ) {
    return "multi_lora";
  }
  if (
    latestFailure?.servingMode === "multi_lora" &&
    /RESOURCE_EXHAUSTED|no available capacity/i.test(
      String(latestFailure.error),
    )
  ) {
    return "multi_lora";
  }
  return "hot_reload_lora";
}

async function readEvaluationExecutionLease(lockPath: string): Promise<{
  pid: number;
  expiresAt: string;
} | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      return { pid: -1, expiresAt: new Date(0).toISOString() };
    }
    return { pid: value.pid, expiresAt: value.expiresAt };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    return { pid: -1, expiresAt: new Date(0).toISOString() };
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function executableBaseRecipe(plan: TrainingPlan) {
  return plan.recipe.method === "sft" || plan.recipe.method === "grpo"
    ? plan.recipe
    : null;
}

async function waitForDataset(
  client: FireworksApiClient,
  accountId: string,
  datasetId: string,
): Promise<Awaited<ReturnType<FireworksApiClient["dataset"]>>> {
  const deadline = Date.now() + 60_000;
  let latest = await client.dataset(accountId, datasetId);
  while (latest.state !== "READY" && Date.now() < deadline) {
    if (latest.status?.code && latest.status.code !== "OK") {
      throw new Error(`Fireworks dataset validation failed: ${latest.status.message ?? latest.status.code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await client.dataset(accountId, datasetId);
  }
  if (latest.state !== "READY") throw new Error("Timed out waiting for Fireworks dataset validation.");
  return latest;
}

const PROVIDER_METRIC_IDENTITY_KEYS = [
  "step",
  "maxSteps",
  "epoch",
  "loss",
  "learningRate",
  "gradientNorm",
  "entropy",
  "meanTokenAccuracy",
  "reward",
  "policyLoss",
  "advantageLoss",
  "inputTokensSeen",
  "memoryBytes",
  "elapsedSeconds",
] as const;

function stableProviderMetricFingerprint(
  source: "fireworks_sft" | "fireworks_rft",
  value: Record<string, unknown>,
): string {
  return contentHash([
    source,
    Object.fromEntries(
      PROVIDER_METRIC_IDENTITY_KEYS.map((key) => [key, value[key] ?? null]),
    ),
  ]);
}

function metadataString(job: TrainingJob, key: string): string {
  const value = job.metadata[key];
  if (typeof value !== "string" || !value) throw new Error(`Fireworks job is missing ${key}.`);
  return value;
}

function metadataNumber(job: TrainingJob, key: string): number | null {
  const value = job.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function artifactKind(filename: string): TrainingArtifact["kind"] {
  const lower = filename.toLowerCase();
  if (lower.includes("adapter") || lower.endsWith(".safetensors")) return "adapter";
  if (lower.includes("metric")) return "metrics";
  if (lower.includes("log")) return "log";
  if (lower.includes("manifest") || lower.endsWith(".json")) return "manifest";
  return "checkpoint";
}

function safeArtifactName(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  if (!basename || basename === "." || basename === "..") {
    throw new Error("Fireworks returned an invalid artifact filename.");
  }
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isConflict(error: unknown): boolean {
  return errorMessage(error).includes("(409)");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
