import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
  DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
  DATASET_NO_TOOLS_CONTRACT_HASH,
  ModelArtifactLineageSchema,
  TrainingDestinationCapabilitiesSchema,
  TrainingJobSchema,
  type TrainingApproval,
  type TrainingArtifact,
  type TrainingCompatibilityReport,
  type TrainingDestinationCapabilities,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  validateTrainingCompatibility,
  type TrainingDestination,
} from "@openpond/training-sdk";
import { resolveCrossSystemTrainTask } from "./cross-system-operations/task-context.js";
import {
  fireworksMoneyUsd,
  fireworksRftChunkSize,
  fireworksRftOptimizerSteps,
  fireworksRftRolloutCount,
  type FireworksSftJob,
} from "./fireworks-client.js";
import {
  renderFireworksRftDataset,
  renderFireworksSftDataset,
} from "./fireworks-dataset.js";
import {
  type FireworksDestinationDeps,
} from "./fireworks-destination-base.js";
import { FireworksDestinationJob } from "./fireworks-destination-job.js";
import {
  evaluationDeploymentLeases,
  unloadEvaluationLoras,
} from "./fireworks-evaluation-runtime.js";
import {
  errorMessage,
  isConflict,
  metadataNumber,
  metadataString,
  normalizedJob,
  providerId,
  providerJobState,
  providerOutputModel,
  providerProgress,
  providerTerminalReceiptComplete,
  waitForDataset,
} from "./fireworks-provider-utils.js";

export {
  selectFireworksEvaluationAccelerator,
  selectFireworksTrainedServingMode,
  withFireworksEvaluationExecutionLock,
} from "./fireworks-evaluation-runtime.js";
export { providerOptimizerUpdates } from "./fireworks-provider-utils.js";

const FIREWORKS_MODEL_ALLOWLIST = [
  "accounts/fireworks/models/qwen3-0p6b",
  "accounts/fireworks/models/qwen3-8b",
] as const;
const FIREWORKS_MAX_DATASET_BYTES = 1_000_000;
const FIREWORKS_MAX_APPROVED_COST_USD = 9.99;
const FIREWORKS_SFT_PRICE_PER_MILLION_TOKENS_USD = 0.5;
const FIREWORKS_CONSERVATIVE_MINIMUM_USD = 3;
const FIREWORKS_FROZEN_EVALUATION_RUNTIME_VERSION =
  "fireworks-dedicated-cross-system-harness-v2";
const TERMINAL_JOB_STATES = new Set(["cancelled", "succeeded", "failed"]);
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

export class FireworksTrainingDestination
  extends FireworksDestinationJob
  implements TrainingDestination {
  constructor(deps: FireworksDestinationDeps) {
    super(deps);
  }

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
    let selection = null;
    try {
      selection = await this.deps.resolveTrainingSelection?.({
        taskset,
        plan,
        split: "train",
        maximumBytes: FIREWORKS_MAX_DATASET_BYTES,
      }) ?? null;
      if (!selection) {
        throw new Error("Fireworks training row selection is unavailable.");
      }
    } catch (error) {
      issues.push({
        code: "fireworks_dataset_projection_failed",
        severity: "error" as const,
        path: "taskset.datasetArtifact",
        message: errorMessage(error),
      });
    }
    if (plan.recipe.method === "grpo") {
      const trainExampleCount = selection?.records.length ?? 0;
      const requiredRollouts = fireworksRftRolloutCount(
        trainExampleCount,
        plan.recipe.rollout.groupSize,
      );
      if (plan.recipe.resourceLimits.maxRollouts < requiredRollouts) {
        issues.push({
          code: "fireworks_rft_rollout_budget_too_small",
          severity: "error" as const,
          path: "recipe.resourceLimits.maxRollouts",
          message:
            `Fireworks needs at least ${requiredRollouts} admitted rollouts for `
            + `${trainExampleCount} prompts with group size `
            + `${plan.recipe.rollout.groupSize}; the recipe allows `
            + `${plan.recipe.resourceLimits.maxRollouts}.`,
        });
      }
      const crossSystem =
        plan.recipe.reward.environmentId === "cross-system-operations";
      const exactAnswer =
        plan.recipe.reward.environmentId
        === DATASET_EXACT_ANSWER_ENVIRONMENT_ID;
      if (!crossSystem && !exactAnswer) {
        issues.push({
          code: "fireworks_rft_environment_unsupported",
          severity: "error" as const,
          path: "recipe.reward.environmentId",
          message:
            "Fireworks RFT supports Cross-System Operations or the Dataset exact-answer environment.",
        });
      }
      if (exactAnswer) {
        const gate = plan.rftSignalGate;
        const report = gate
          ? (await this.deps.store.listBaselineReports(taskset.id)).find(
              (candidate) => candidate.id === gate.baselineReportId,
            ) ?? null
          : null;
        const gateAligned = Boolean(
          gate
          && report
          && contentHash(report) === gate.baselineReportHash
          && report.tasksetHash === taskset.contentHash
          && gate.scope.split === "train"
          && gate.scope.taskCount === trainExampleCount
          && gate.scope.attemptsPerTask === plan.recipe.rollout.groupSize
          && gate.scope.selectionSeed === plan.recipe.rollout.seed
          && gate.scope.selectionStrategy === plan.recipe.dataset.selectionStrategy
          && gate.scope.taskIdsHash === selection?.taskIdsHash
          && gate.scope.model.providerId === "fireworks"
          && gate.scope.model.modelId === plan.recipe.baseModel.id
          && gate.scope.sampling.maxOutputTokens === plan.recipe.rollout.maxOutputTokens
          && gate.scope.sampling.temperature === plan.recipe.rollout.temperature
          && gate.scope.sampling.topP === plan.recipe.rollout.topP,
        );
        if (!gateAligned) {
          issues.push({
            code: "fireworks_rft_signal_gate_missing",
            severity: "error" as const,
            path: "plan.rftSignalGate",
            message:
              "Run the train-signal check for this exact base model, prompt selection, and rollout configuration before preparing paid RFT.",
          });
        } else if (
          !gate!.signal.passed
          || gate!.signal.infrastructureFailures > 0
          || gate!.signal.mixedRewardGroups
            < gate!.signal.requiredMixedRewardGroups
        ) {
          issues.push({
            code: "fireworks_rft_signal_gate_failed",
            severity: "error" as const,
            path: "plan.rftSignalGate.signal",
            message:
              `The aligned train-signal check found ${gate!.signal.mixedRewardGroups} mixed-reward groups; `
              + `${gate!.signal.requiredMixedRewardGroups} are required with zero infrastructure failures.`,
          });
        }
      }
      const expectedEnvironmentVersion = crossSystem
        ? CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION
        : DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION;
      if (plan.recipe.reward.environmentVersion !== expectedEnvironmentVersion) {
        issues.push({
          code: "fireworks_rft_environment_stale",
          severity: "error" as const,
          path: "recipe.reward.environmentVersion",
          message:
            "The Fireworks RFT environment version does not match the selected local verifier runtime.",
        });
      }
      const expectedToolContractHash = crossSystem
        ? CROSS_SYSTEM_TOOL_CONTRACT_HASH
        : DATASET_NO_TOOLS_CONTRACT_HASH;
      if (plan.recipe.reward.toolContractHash !== expectedToolContractHash) {
        issues.push({
          code: "fireworks_rft_tool_contract_stale",
          severity: "error" as const,
          path: "recipe.reward.toolContractHash",
          message:
            "The Fireworks RFT tool contract does not match the selected environment.",
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
      if (crossSystem) {
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
      } else if (
        taskset.capabilities.requiresTools
        || taskset.capabilities.requiresState
        || !taskset.graders.some((grader) =>
          grader.id === (
            plan.recipe.method === "grpo"
              ? plan.recipe.reward.graderId
              : ""
          )
          && grader.kind === "content"
          && grader.rewardEligible
          && grader.config.operator === "final_answer_equals_expected")
      ) {
        issues.push({
          code: "fireworks_exact_answer_contract_invalid",
          severity: "error" as const,
          path: "taskset.graders",
          message:
            "Dataset exact-answer RFT requires a stateless, tool-free Taskset with a reward-eligible final-answer grader.",
        });
      }
      if (trainExampleCount === 0) {
        issues.push({
          code: "fireworks_rft_training_rows_missing",
          severity: "error" as const,
          path: "taskset.datasetArtifact",
          message: "Fireworks RFT requires at least one projected train prompt.",
        });
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
        if (
          plan.recipe.method === "grpo"
          && model.trainingContextLength
          && plan.recipe.dataset.maxPromptTokens
            + plan.recipe.rollout.maxOutputTokens
            > model.trainingContextLength
        ) {
          issues.push({
            code: "fireworks_rft_context_length_exceeded",
            severity: "error" as const,
            path: "recipe.rollout.maxOutputTokens",
            message:
              `The ${plan.recipe.dataset.maxPromptTokens}-token prompt limit plus the `
              + `${plan.recipe.rollout.maxOutputTokens}-token output limit exceeds `
              + `${selectedBaseModelId}'s ${model.trainingContextLength}-token training context.`,
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
    const dataset = selection
      ? plan.recipe.method === "grpo"
        ? renderFireworksRftDataset(taskset, plan.recipe, selection)
        : renderFireworksSftDataset(taskset, selection)
      : null;
    if (dataset && dataset.bytes.byteLength > FIREWORKS_MAX_DATASET_BYTES) {
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
    const selection = await this.deps.resolveTrainingSelection?.({
      taskset,
      plan,
      split: "train",
      maximumBytes: FIREWORKS_MAX_DATASET_BYTES,
    });
    if (!selection) {
      throw new Error("Fireworks training row selection is unavailable.");
    }
    if (plan.recipe.method === "grpo") {
      const dataset = renderFireworksRftDataset(taskset, plan.recipe, selection);
      const chunkSize = fireworksRftChunkSize(
        dataset.exampleCount,
        plan.recipe.optimizer.maxSteps,
      );
      const optimizerSteps = fireworksRftOptimizerSteps(
        dataset.exampleCount,
        chunkSize,
      );
      const rolloutCount = fireworksRftRolloutCount(
        dataset.exampleCount,
        plan.recipe.rollout.groupSize,
      );
      return {
        estimatedCostUsd: FIREWORKS_CONSERVATIVE_MINIMUM_USD,
        assumptions: [
          `Bounded ${plan.recipe.loss.method === "gspo-token" ? "GSPO-token" : plan.recipe.loss.method.toUpperCase()} RFT on ${plan.recipe.baseModel.id}.`,
          `${dataset.exampleCount} train prompts × ${plan.recipe.rollout.groupSize} candidates = ${rolloutCount} admitted rollouts.`,
          `Fireworks chunk size ${chunkSize} produces ${optimizerSteps} planned optimizer updates for one epoch.`,
          "Fireworks currently documents RFT as free for models under 16B; a conservative $3 approval reserve covers independent evaluation inference and pricing changes.",
          "The launch still fails closed above the explicit user maximum.",
        ],
      };
    }
    const dataset = renderFireworksSftDataset(taskset, selection);
    if (plan.recipe.method !== "sft") throw new Error("Fireworks quote requires an executable SFT or RFT recipe.");
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
    const selection = await this.deps.resolveTrainingSelection?.({
      taskset,
      plan,
      split: "train",
      maximumBytes: FIREWORKS_MAX_DATASET_BYTES,
    });
    if (!selection) {
      throw new Error("Fireworks training row selection is unavailable.");
    }
    const rendered = renderFireworksSftDataset(taskset, selection);
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

}
