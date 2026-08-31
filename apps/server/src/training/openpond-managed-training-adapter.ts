import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ModelProjectSchema,
  AdapterValidationReceiptSchema,
  TrainingArtifactsSchema,
  TrainingEngineCapabilitiesSchema,
  TrainingExecutionStatusSchema,
  TrainingJobEventSchema,
  type AdapterValidationReceipt,
  type LearningSignalBatch,
  type RewardModelRecipe,
  type ResolvedTrainingPlan,
  type TrainingArtifacts,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { TrainingEngineAdapter } from "@openpond/training-sdk";
import {
  createTrainingClient,
  parseAndVerifyTrainingExecutionReceipt,
  trainingExecutionReceiptHash,
  trainingInputArtifactUploadHash,
  trainingJobSubmissionHash,
  type TrainingJobSubmission,
} from "openpond-sdk/training";
import { createModelProjectsClient } from "openpond-sdk/model-projects";

import type { SqliteStore } from "../store/store.js";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";
import { ManagedRlLocalRolloutExecutor } from "./managed-rl-local-rollout-executor.js";
import { supportsManagedRlHarness } from "./managed-rl-harness-registry.js";
import {
  dateString,
  learnedRewardSource,
  managedJobFromPublic,
  managedQualification,
  recordOrEmpty,
  requiredFiniteNumber,
  requiredHash,
  requiredPositiveInteger,
  requiredRecord,
  requiredRef,
  requiredStringValue,
  toExecutionStatus,
} from "./openpond-managed-training-adapter-projection.js";
import {
  localTrainingEventType,
  type ManagedTrainingAccess as Access,
  type ManagedTrainingJob as ManagedJob,
} from "./openpond-managed-training-adapter-support.js";
import { resolveTasksetEvaluationAssetBytes } from "./taskset-work-assets.js";

const ADAPTER_ID = "sandbox-managed-rl";
const REMOTE_TRAINING_EVENT_SEQUENCE_BASE = 1_000_000;
const ACTIVE_EVIDENCE_REFRESH_TTL_MS = 1_500;

export type OpenPondManagedTrainingAdapterDependencies = {
  store: SqliteStore;
  storeDir: string;
  fetchImpl?: typeof fetch;
  resolveAccess?: (teamId?: string) => Promise<Access>;
  readFileImpl?: typeof readFile;
  env?: Record<string, string | undefined>;
};

export class OpenPondManagedTrainingAdapter implements TrainingEngineAdapter {
  readonly id = ADAPTER_ID;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAccess: (teamId?: string) => Promise<Access>;
  private readonly readFileImpl: typeof readFile;
  private readonly localExecutors = new Map<string, ManagedRlLocalRolloutExecutor>();
  private readonly evidenceRefreshes = new Map<string, Promise<void>>();
  private readonly evidenceRefreshedAt = new Map<string, number>();

  constructor(private readonly dependencies: OpenPondManagedTrainingAdapterDependencies) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.resolveAccess =
      dependencies.resolveAccess ?? ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
    this.readFileImpl = dependencies.readFileImpl ?? readFile;
  }

  async createCalibrationBatch(request: unknown) {
    return this.requestJson<{ job: ManagedJob; requestHash: string }>(
      "/v1/managed-rl/calibration-batches",
      { method: "POST", body: JSON.stringify(request) },
      await this.resolveBoundAccess(),
    );
  }

  async calibrationBatch(jobId: string) {
    return this.requestJson<{ job: ManagedJob; batch: unknown | null }>(
      `/v1/managed-rl/calibration-batches/${encodeURIComponent(jobId)}`,
      {},
      await this.resolveBoundAccess(),
    );
  }

  async createRewardModelLaunch(input: {
    request: unknown;
    modelProjectId: string;
    processorRelease: { id: string; contentHash: string };
    recipe: RewardModelRecipe;
    approvedAt: string;
  }) {
    const request = requiredRecord(input.request, "Reward Model launch request");
    const requestHash = requiredHash(request.requestHash, "Reward Model request hash");
    const rewardModelTraining = requiredRecord(
      request.rewardModelTraining,
      "Reward Model training payload",
    );
    const taskset = requiredRecord(request.taskset, "Reward Model Taskset");
    const preferenceDataset = requiredRef(
      request.preferenceDatasetRelease,
      "Reward Model preference dataset",
    );
    const base = requiredRecord(rewardModelTraining.baseModel, "Reward Model base Model");
    const projectValue = await this.dependencies.store.getModelProject(input.modelProjectId);
    if (!projectValue) throw new Error("Reward Model Model Project was not found.");
    const access = await this.resolveBoundAccess();
    const project = await this.syncProjectForSubmission(projectValue, access);
    if (!project.hosted || !project.trainingSetup.harnessRelease) {
      throw new Error("Reward Model training requires a synchronized Project Harness release.");
    }
    const tasksetRelease = project.trainingSetup.tasksetRelease;
    if (
      !tasksetRelease ||
      tasksetRelease.id !== requiredStringValue(taskset.id, "Reward Model Taskset id") ||
      tasksetRelease.contentHash !== requiredHash(taskset.contentHash, "Reward Model Taskset hash")
    ) {
      throw new Error("Reward Model training does not match the Model Project Taskset release.");
    }
    const client = this.trainingClient(access);
    const artifactContent = {
      schemaVersion: "openpond.trainingInputArtifactUpload.v2" as const,
      kind: "reward_model_dataset" as const,
      idempotencyKey: `stage:${requestHash}`,
      sourceManifest: {
        id: requiredStringValue(request.sourceRunRef, "Reward Model source Run"),
        contentHash: requestHash,
      },
      payload: rewardModelTraining,
    };
    const staged = await client.stageArtifact({
      ...artifactContent,
      contentHash: await trainingInputArtifactUploadHash(artifactContent),
    });
    const maximumSpendUsd = requiredFiniteNumber(
      request.maximumSpendUsd,
      "Reward Model maximum spend",
    );
    const approvalHash = contentHash({
      sourceRunRef: request.sourceRunRef,
      requestHash,
      maximumSpendUsd,
      approvedAt: input.approvedAt,
    });
    const jobContent: Omit<TrainingJobSubmission, "contentHash"> = {
      schemaVersion: "openpond.trainingJobSubmission.v2",
      idempotencyKey: requiredStringValue(request.idempotencyKey, "Reward Model idempotency key"),
      name: requiredStringValue(request.name, "Reward Model name").slice(0, 200),
      source: {
        modelProject: {
          id: project.hosted.projectId,
          portableProjectId: project.id,
          revision: project.revision,
          contentHash: project.hosted.etag,
        },
        harnessRunManifest: artifactContent.sourceManifest,
        harnessRelease: project.trainingSetup.harnessRelease,
        taskset: {
          id: tasksetRelease.id,
          revision: requiredPositiveInteger(taskset.revision, "Reward Model Taskset revision"),
          contentHash: tasksetRelease.contentHash,
        },
        tasksetRelease,
        dataset: { id: staged.artifactRef, contentHash: staged.contentHash },
        evidenceSets: [preferenceDataset],
      },
      job: {
        kind: "reward_model_train",
        baseModel: {
          schemaVersion: "openpond.baseModelPreference.v1",
          modelId: requiredStringValue(base.repoId, "Reward Model repository"),
          revision: requiredStringValue(base.revision, "Reward Model revision"),
          tokenizerRevision: requiredStringValue(base.revision, "Reward Model tokenizer revision"),
          chatTemplateHash: requiredHash(base.tokenizerHash, "Reward Model tokenizer hash"),
          modelAssetId: null,
          source: "managed",
        },
        preferenceDatasetRelease: preferenceDataset,
        processorRelease: input.processorRelease,
        recipe: input.recipe,
      },
      requestedCapabilities: [
        { id: "managed_rl.reward_model", version: "1", required: true },
      ],
      budget: {
        maximumSpendUsd,
        maximumWallSeconds: Math.ceil(input.recipe.resourceLimits.wallTimeMs / 1_000),
      },
      approval: {
        approvalHash,
        approvedAt: input.approvedAt,
        exportApproved: true,
        maximumSpendUsd,
        retentionDays: project.trainingSetup.preferredRetentionDays,
        region: null,
      },
    };
    const submission = {
      ...jobContent,
      contentHash: await trainingJobSubmissionHash(jobContent),
    };
    const job = await client.createJob(submission);
    return { job: managedJobFromPublic(job), requestHash: submission.contentHash };
  }

  async rewardModelJob(jobId: string) {
    const access = await this.resolveBoundAccess();
    const client = this.trainingClient(access);
    const job = await client.getJob(jobId);
    const output = job.state === "succeeded" ? await client.outputs(jobId) : null;
    const scorer = output?.outputs.find((candidate) => candidate.kind === "scorer");
    return {
      job: {
        ...managedJobFromPublic(job),
        cleanupAttestation: output?.receipt?.cleanupComplete === true ? { complete: true } : null,
      },
      resources: scorer
        ? [{
            kind: "artifact_upload",
            state: "consumed",
            metadata: {
              ...scorer.metadata,
              objectPrefix: scorer.artifactRef,
              artifactSha256: scorer.contentHash,
            },
          }]
        : [],
      outputs: output,
      executionReceiptRef: output?.receipt
        ? {
            id: output.receipt.id,
            contentHash: await trainingExecutionReceiptHash(output.receipt),
          }
        : null,
    };
  }

  async cancelRewardModelJob(jobId: string, expectedVersion: number) {
    const client = this.trainingClient(await this.resolveBoundAccess());
    return { job: managedJobFromPublic(await client.cancelJob(jobId, expectedVersion)) };
  }

  async capabilities() {
    const access = await this.resolveBoundAccess();
    const capabilities = await this.trainingClient(access).capabilities();
    const available = Date.parse(capabilities.expiresAt) > Date.now();
    return TrainingEngineCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingEngineCapabilities.v1",
      adapterId: this.id,
      available,
      methods: capabilities.methods,
      signalKinds: ["trajectory", "reward", "grader_evidence", "infrastructure_failure"],
      modelFamilies: ["transformers"],
      precisions: ["bf16"],
      topologies: capabilities.placements.map((placement) => `managed_${placement}`),
      workerProtocolVersion: "openpond.training.v2",
      upstreamRevision: capabilities.capabilityHash,
      workerImageDigest: null,
      capabilityReceipt: capabilities.capabilityHash,
      checkedAt: capabilities.checkedAt,
      unavailableReason: available ? null : "Managed Training capabilities expired.",
    });
  }

  async validate(plan: ResolvedTrainingPlan): Promise<AdapterValidationReceipt> {
    const issues: AdapterValidationReceipt["issues"] = [];
    const publicCapabilities = await this.trainingClient(
      await this.resolveBoundAccess(),
    ).capabilities();
    if (
      plan.engine.adapterId !== this.id ||
      plan.compute.adapterId !== "openpond-managed" ||
      !(
        (plan.runtime.adapterId === "local-harness" &&
          plan.runtime.placement === "local" &&
          plan.runtime.dataPlane === null) ||
        (plan.runtime.adapterId === "openpond-managed-harness" &&
          plan.runtime.placement === "remote")
      )
    ) {
      issues.push({
        code: "managed_binding_mismatch",
        path: "bindings",
        message: "The resolved plan is not bound to OpenPond Managed.",
      });
    }
    if (!publicCapabilities.methods.includes(plan.recipe.method)) {
      issues.push({
        code: "managed_method_unsupported",
        path: "recipe.method",
        message: `OpenPond Managed does not currently advertise ${plan.recipe.method}.`,
      });
    }
    if (!publicCapabilities.placements.includes(plan.runtime.placement)) {
      issues.push({
        code: "managed_placement_unsupported",
        path: "runtime.placement",
        message: `OpenPond Managed does not currently advertise ${plan.runtime.placement} rollout placement.`,
      });
    }
    if (
      plan.maximumSpendUsd === null ||
      plan.maximumSpendUsd > publicCapabilities.limits.maximumSpendUsd
    ) {
      issues.push({
        code: "managed_budget_unsupported",
        path: "maximumSpendUsd",
        message: "The approved spend exceeds the current managed-training capability.",
      });
    }
    if (!plan.execution) {
      issues.push({
        code: "managed_execution_context_missing",
        path: "execution",
        message: "OpenPond Managed requires a persisted plan and approval.",
      });
    } else {
      const [trainingPlan, approval] = await Promise.all([
        this.dependencies.store.getTrainingPlan(plan.execution.trainingPlanId),
        this.dependencies.store.getTrainingApproval(plan.execution.approvalId),
      ]);
      const taskset = trainingPlan
        ? await this.dependencies.store.getTaskset(trainingPlan.tasksetId)
        : null;
      if (
        !trainingPlan ||
        !approval ||
        trainingPlan.destinationId !== "openpond_managed" ||
        trainingPlan.environmentPlacement !== plan.runtime.placement ||
        approval.planId !== trainingPlan.id ||
        approval.destinationId !== "openpond_managed" ||
        contentHash(approval) !== plan.approvalHash ||
        approval.maximumCostUsd !== plan.maximumSpendUsd
      ) {
        issues.push({
          code: "managed_approval_changed",
          path: "execution",
          message: "The persisted OpenPond Managed plan or approval changed.",
        });
      }
      if (taskset && trainingPlan && taskset.contentHash === trainingPlan.tasksetHash) {
        if (taskset.metadata.harnessEvaluationReview !== undefined) {
          const qualification = await managedQualification({
            store: this.dependencies.store,
            taskset,
            qualificationRef: trainingPlan.modelImprovementQualification ?? null,
          });
          if (
            !qualification ||
            qualification.decision !== "rl" ||
            approval?.modelImprovementQualification?.id !== qualification.id ||
            approval.modelImprovementQualification.contentHash !== qualification.contentHash ||
            qualification.metadata.sourceTasksetId !== taskset.id ||
            qualification.metadata.sourceTasksetHash !== taskset.contentHash ||
            (approval.maximumCostUsd !== null && approval.maximumCostUsd > qualification.maximumCostUsd)
          ) {
            issues.push({
              code: "managed_qualification_invalid",
              path: "execution",
              message:
                "OpenPond Managed requires an exact qualified RL receipt on the immutable Taskset, plan, and approval.",
            });
          }
        }
        const requiresHarness =
          taskset.capabilities.requiresState ||
          taskset.capabilities.requiresTools;
        if (
          requiresHarness &&
          !supportsManagedRlHarness(taskset, plan.runtime.placement)
        ) {
          issues.push({
            code: "managed_harness_unsupported",
            path: "taskset.environment",
            message:
              "This Taskset harness is not yet supported by the selected OpenPond Managed rollout placement.",
          });
        }
        if (!requiresHarness) {
          const learnedPreference = plan.recipe.method === "grpo"
            ? plan.recipe.reward.learnedPreference ?? null
            : null;
          const scoredTasks = taskset.tasks.filter(
            (task) => task.split !== "frozen_eval",
          );
          if (
            learnedPreference &&
            (
              taskset.metadata.tasksetOutputContract === undefined
              || scoredTasks.some(
                (task) => typeof task.expectedOutput?.outputSchemaRef !== "string",
              )
            )
          ) {
            issues.push({
              code: "managed_learned_reward_output_contract_missing",
              path: "taskset.metadata.tasksetOutputContract",
              message:
                "Stateless learned-reward tasks require one immutable structured output contract.",
            });
          } else if (
            !learnedPreference &&
            scoredTasks.some(
              (task) =>
                typeof task.expectedOutput?.text !== "string" &&
                typeof task.expectedOutput?.outputSchemaRef !== "string",
            )
          ) {
            issues.push({
              code: "managed_exact_answer_missing",
              path: "taskset.tasks",
              message:
                "Stateless deterministic-reward tasks require an exact expected text answer or a structured output contract.",
            });
          }
        }
      }
    }
    const base = {
      schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
      adapterId: this.id,
      valid: issues.length === 0,
      issues,
      capabilityReceipt: plan.engine.capabilityReceipt,
      planHash: plan.contentHash,
      createdAt: new Date().toISOString(),
    };
    return AdapterValidationReceiptSchema.parse({
      ...base,
      contentHash: contentHash(base),
    });
  }

  async launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    const validation = await this.validate(plan);
    if (!validation.valid || !plan.execution) {
      throw new Error("OpenPond Managed rejected the resolved training plan.");
    }
    const trainingPlan = await this.dependencies.store.getTrainingPlan(
      plan.execution.trainingPlanId,
    );
    if (!trainingPlan) {
      throw new Error("The managed training plan is no longer available.");
    }
    const taskset = await this.dependencies.store.getTaskset(trainingPlan.tasksetId);
    if (!taskset) {
      throw new Error("The managed training Taskset is no longer available.");
    }
    if (taskset.contentHash !== trainingPlan.tasksetHash) {
      throw new Error("The managed training Taskset changed before launch.");
    }
    const validationTasks = taskset.tasks.filter(
      (task) => task.split === "frozen_eval" || task.split === "validation",
    );
    if (validationTasks.length === 0) {
      throw new Error("OpenPond Managed requires at least one private validation task.");
    }
    const validationAssetBytes = taskset.environment.kind === "work"
      ? await resolveTasksetEvaluationAssetBytes({
          storeDir: this.dependencies.storeDir,
          taskset,
        })
      : new Map<string, Uint8Array>();
    const validationAssets = [...validationAssetBytes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetPath, value]) => ({
        path: assetPath,
        sha256: sha256(value),
        sizeBytes: value.byteLength,
        encoding: "base64" as const,
        content: Buffer.from(value).toString("base64"),
      }));
    const bundleDirectory = path.join(
      this.dependencies.storeDir,
      "training",
      "portable-releases",
      "resolved-bundles",
      plan.manifest.resolvedBundleHash,
    );
    const bundleManifest = JSON.parse(
      await this.readFileImpl(path.join(bundleDirectory, "bundle-manifest.json"), "utf8"),
    ) as {
      files: Array<{ path: string; sha256: string; sizeBytes: number }>;
      contentHash: string;
      datasetRelease: { id: string; contentHash: string };
      evidenceSetRelease: { id: string; contentHash: string } | null;
    };
    if (bundleManifest.contentHash !== plan.manifest.resolvedBundleHash) {
      throw new Error("The managed resolved bundle changed before upload.");
    }
    const files = await Promise.all(
      bundleManifest.files.map(async (file) => {
        const value = await this.readFileImpl(path.join(bundleDirectory, file.path));
        if (value.byteLength !== file.sizeBytes || sha256(value) !== file.sha256) {
          throw new Error(`Managed training bundle file ${file.path} changed before upload.`);
        }
        return {
          ...file,
          encoding: "base64" as const,
          content: value.toString("base64"),
        };
      }),
    );
    let project = await this.dependencies.store.getModelProject(
      trainingPlan.modelId,
    );
    if (!project) {
      throw new Error("The managed Model Project is no longer available.");
    }
    const access = await this.resolveBoundAccess();
    project = await this.syncProjectForSubmission(project, access);
    if (
      !project?.hosted ||
      project.hosted.syncedSourceRevision !== project.revision ||
      project.hosted.portableProjectId !== project.id
    ) {
      throw new Error(
        "Sync the exact Model Project revision before creating managed training.",
      );
    }
    if (plan.recipe.method !== "grpo" || plan.maximumSpendUsd === null) {
      throw new Error("Managed Training V2 requires GRPO and an approved spend ceiling.");
    }
    const baseModel = project.trainingSetup.baseModel;
    if (
      !baseModel ||
      baseModel.modelId !== plan.manifest.model.source ||
      baseModel.revision !== plan.manifest.model.revision ||
      baseModel.tokenizerRevision !== plan.manifest.model.tokenizerRevision ||
      baseModel.chatTemplateHash !== plan.manifest.model.chatTemplateHash
    ) {
      throw new Error("The synced Model Project base Model does not match the Run manifest.");
    }
    const portableSubmission = {
      schemaVersion: "openpond.managedRlPortableSubmission.v1" as const,
      sourceRunRef: `openpond:model-run:${plan.manifest.id}`,
      name: `OpenPond Managed · ${trainingPlan.modelId}`.slice(0, 191),
      idempotencyKey: `openpond-managed:${plan.manifest.contentHash}`.slice(0, 191),
      modelProject: {
        id: project.hosted.projectId,
        portableProjectId: project.hosted.portableProjectId,
      },
      manifest: plan.manifest,
      sourceTaskset: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      modelImprovementQualification:
        trainingPlan.modelImprovementQualification ?? null,
      recipe: plan.recipe,
      resolvedBundle: {
        manifest: bundleManifest,
        files,
      },
      validationTasks,
      validationAssets,
    };
    const client = this.trainingClient(access);
    const stagedContent = {
      schemaVersion: "openpond.trainingInputArtifactUpload.v2" as const,
      kind: "portable_training_bundle" as const,
      idempotencyKey: `stage:${plan.manifest.contentHash}`,
      sourceManifest: {
        id: plan.manifest.id,
        contentHash: plan.manifest.contentHash,
      },
      payload: portableSubmission,
    };
    const staged = {
      ...stagedContent,
      contentHash: await trainingInputArtifactUploadHash(stagedContent),
    };
    await client.stageArtifact(staged);
    const grader = taskset.graders[0];
    if (!grader) throw new Error("Managed training requires an immutable grader.");
    const learnedPreference = plan.recipe.reward.learnedPreference ?? null;
    const rewardSource = learnedPreference
      ? learnedRewardSource(learnedPreference)
      : {
          kind: "deterministic" as const,
          grader: { id: grader.id, contentHash: contentHash(grader) },
          composer: null,
        };
    const jobContent: Omit<TrainingJobSubmission, "contentHash"> = {
      schemaVersion: "openpond.trainingJobSubmission.v2",
      idempotencyKey: `openpond-training-v2:${plan.manifest.contentHash}`,
      name: `OpenPond Managed · ${trainingPlan.modelId}`.slice(0, 200),
      source: {
        modelProject: {
          id: project.hosted.projectId,
          portableProjectId: project.hosted.portableProjectId,
          revision: project.revision,
          contentHash: project.hosted.etag,
        },
        harnessRunManifest: {
          id: plan.manifest.id,
          contentHash: plan.manifest.contentHash,
        },
        harnessRelease: plan.manifest.harnessRelease,
        taskset: {
          id: taskset.id,
          revision: taskset.revision,
          contentHash: taskset.contentHash,
        },
        tasksetRelease: {
          id: taskset.id,
          contentHash: taskset.contentHash,
        },
        dataset: bundleManifest.datasetRelease,
        evidenceSets: bundleManifest.evidenceSetRelease
          ? [bundleManifest.evidenceSetRelease]
          : [],
      },
      job: {
        kind: "policy_optimize",
        baseModel,
        recipe: plan.recipe,
        rewardSource,
        resumeFrom: null,
      },
      requestedCapabilities: [
        { id: "managed_rl.policy.grpo", version: "1", required: true },
        {
          id: `managed_rl.rollouts.${plan.runtime.placement}`,
          version: "1",
          required: true,
        },
      ],
      budget: {
        maximumSpendUsd: plan.maximumSpendUsd,
        maximumWallSeconds: Math.ceil(plan.recipe.resourceLimits.wallTimeMs / 1_000),
      },
      approval: {
        approvalHash: plan.approvalHash,
        approvedAt: plan.manifest.approval.approvedAt,
        exportApproved: true,
        maximumSpendUsd: plan.maximumSpendUsd,
        retentionDays: trainingPlan.dataPolicy.retentionDays,
        region: trainingPlan.dataPolicy.region,
      },
    };
    const publicSubmission = {
      ...jobContent,
      contentHash: await trainingJobSubmissionHash(jobContent),
    };
    const job = await client.createJob(publicSubmission);
    const ref = {
      runId: job.id,
      adapterId: this.id,
      protocolVersion: "openpond.training.v2" as const,
      routeFamily: "training_v2" as const,
      providerJobId: job.id,
      tenantId: access.teamId,
      leaseId: null,
      manifestHash: plan.manifest.contentHash,
      inputBundleHash: publicSubmission.contentHash,
      createdAt: dateString(job.createdAt),
    };
    if (plan.runtime.placement === "local") {
      this.ensureLocalExecutor(ref, access, plan.manifest.harnessRelease.contentHash);
    }
    return ref;
  }

  async consumeSignals(_ref: TrainingExecutionRef, _batch: LearningSignalBatch): Promise<void> {
    throw new Error("OpenPond Managed consumes the immutable submitted training bundle.");
  }

  async status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus> {
    const access = await this.resolveBoundAccess(ref.tenantId);
    const job = await this.trainingClient(access).getJob(ref.runId);
    const localJob = await this.dependencies.store.getTrainingJob(ref.runId);
    const bindings = recordOrEmpty(localJob?.metadata.portableAdapterBindings);
    const runtime = recordOrEmpty(bindings.runtime);
    const placement = runtime.placement;
    if (placement === "local") {
      const storedHarnessHash = localJob?.metadata.harnessReleaseHash;
      this.ensureLocalExecutor(
        ref,
        access,
        typeof storedHarnessHash === "string" ? storedHarnessHash : undefined,
      );
    }
    if (
      ["succeeded", "cancelled", "failed"].includes(job.state)
    ) {
      const executor = this.localExecutors.get(ref.runId);
      this.localExecutors.delete(ref.runId);
      void executor?.stop();
    }
    return TrainingExecutionStatusSchema.parse(toExecutionStatus(job));
  }

  async refreshEvidence(ref: TrainingExecutionRef): Promise<void> {
    const localJob = await this.dependencies.store.getTrainingJob(ref.runId);
    const terminal = localJob
      ? ["succeeded", "failed", "cancelled"].includes(localJob.status)
      : false;
    const snapshot = recordOrEmpty(
      localJob?.metadata.managedEvidenceSnapshot,
    );
    if (
      terminal
      && snapshot.syncedJobUpdatedAt === localJob?.updatedAt
    ) {
      return;
    }
    const active = this.evidenceRefreshes.get(ref.runId);
    if (active) return active;
    const refreshedAt = this.evidenceRefreshedAt.get(ref.runId) ?? 0;
    if (
      !terminal
      && Date.now() - refreshedAt < ACTIVE_EVIDENCE_REFRESH_TTL_MS
    ) return;
    const refresh = this.refreshEvidenceOnce(ref).finally(() => {
      if (this.evidenceRefreshes.get(ref.runId) === refresh) {
        this.evidenceRefreshes.delete(ref.runId);
        this.evidenceRefreshedAt.set(ref.runId, Date.now());
      }
    });
    this.evidenceRefreshes.set(ref.runId, refresh);
    return refresh;
  }

  private async refreshEvidenceOnce(ref: TrainingExecutionRef): Promise<void> {
    const storedEvents = await this.dependencies.store.listTrainingJobEvents(ref.runId);
    const client = this.trainingClient(await this.resolveBoundAccess(ref.tenantId));
    const events = await client.events(ref.runId);
    const storedById = new Map(storedEvents.map((event) => [event.id, event]));
    const occupiedSequences = new Set(storedEvents.map((event) => event.sequence));
    let nextSequence = Math.max(
      REMOTE_TRAINING_EVENT_SEQUENCE_BASE - 1,
      ...storedEvents.map((event) => event.sequence),
    );
    for (const event of events) {
      const stored = storedById.get(event.id);
      const projectedSequence = REMOTE_TRAINING_EVENT_SEQUENCE_BASE + event.sequence;
      const sequence = stored?.sequence ?? (
        occupiedSequences.has(projectedSequence)
          ? ++nextSequence
          : projectedSequence
      );
      occupiedSequences.add(sequence);
      nextSequence = Math.max(nextSequence, sequence);
      await this.dependencies.store.saveTrainingJobEvent(TrainingJobEventSchema.parse({
        schemaVersion: "openpond.trainingJobEvent.v1",
        id: event.id,
        jobId: ref.runId,
        sequence,
        type: localTrainingEventType(event),
        timestamp: event.createdAt,
        payload: {
          ...event.data,
          remoteEventType: event.type,
          remotePhase: event.phase,
          ...(event.message ? { message: event.message } : {}),
        },
      }));
    }
    const refreshedJob = await this.dependencies.store.getTrainingJob(ref.runId);
    if (
      refreshedJob
      && ["succeeded", "failed", "cancelled"].includes(refreshedJob.status)
    ) {
      await this.dependencies.store.saveTrainingJob({
        ...refreshedJob,
        metadata: {
          ...refreshedJob.metadata,
          managedEvidenceSnapshot: {
            schemaVersion: "openpond.managedEvidenceSnapshot.v1",
            syncedJobUpdatedAt: refreshedJob.updatedAt,
            eventCount: events.length,
            syncedAt: new Date().toISOString(),
          },
        },
      });
    }
  }

  async logs(ref: TrainingExecutionRef, cursor?: string) {
    const logs = await this.trainingClient(
      await this.resolveBoundAccess(ref.tenantId),
    ).logs(ref.runId);
    const after = cursor === undefined ? -1 : Number.parseInt(cursor, 10);
    const entries = logs
      .filter((entry) => !Number.isFinite(after) || entry.sequence >= after)
      .map((entry) => ({
        timestamp: entry.createdAt,
        level: entry.level,
        message: entry.message,
      }));
    const next = logs.length === 0 ? Math.max(after, 0) : logs.at(-1)!.sequence + 1;
    return { cursor: String(next), entries };
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    const executor = this.localExecutors.get(ref.runId);
    this.localExecutors.delete(ref.runId);
    void executor?.stop();
    const access = await this.resolveBoundAccess(ref.tenantId);
    const client = this.trainingClient(access);
    const current = await client.getJob(ref.runId);
    await client.cancelJob(ref.runId, current.version);
  }

  async close(): Promise<void> {
    const executors = [...this.localExecutors.values()];
    this.localExecutors.clear();
    await Promise.all(executors.map((executor) => executor.stop()));
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const access = await this.resolveBoundAccess(ref.tenantId);
    const output = await this.trainingClient(access).outputs(ref.runId);
    if (!output.receipt) {
      throw new Error("Sandbox completed managed training without an execution receipt.");
    }
    const receiptOutput = output.outputs.find((candidate) => candidate.kind === "receipt");
    if (!receiptOutput) {
      throw new Error("Sandbox completed managed training without a receipt artifact.");
    }
    await parseAndVerifyTrainingExecutionReceipt(output.receipt, {
      id: output.receipt.id,
      contentHash: receiptOutput.contentHash,
      teamId: access.teamId,
      jobId: ref.runId,
      requireCleanup: true,
    });
    const adapterOutput = output.outputs.find((candidate) => candidate.kind === "adapter");
    if (!adapterOutput) {
      throw new Error("Sandbox completed managed training without an adapter artifact.");
    }
    const artifacts = output.outputs
      .filter((candidate) => candidate.kind !== "scorer")
      .map((candidate) => ({
        kind: candidate.kind,
        objectRef:
          `sandbox-managed-rl://${encodeURIComponent(ref.runId)}/` +
          encodeURIComponent(candidate.id),
        sha256: candidate.contentHash,
        sizeBytes: candidate.sizeBytes,
      }));
    const base = {
      runId: ref.runId,
      manifestHash:
        ref.manifestHash ??
        (() => {
          throw new Error("Managed execution lost its source manifest hash.");
        })(),
      artifacts,
    };
    return TrainingArtifactsSchema.parse({
      ...base,
      contentHash: contentHash(base),
    });
  }

  private async requestJson<T>(
    pathname: string,
    init: RequestInit = {},
    suppliedAccess?: Access,
  ): Promise<T> {
    const access = suppliedAccess ?? (await this.resolveBoundAccess());
    const requestUrl = `${access.apiBaseUrl}${pathname}`;
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(requestUrl, { ...init, headers });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };
    if (!response.ok) {
      throw new Error(
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
            ? payload.error
            : `OpenPond Managed request failed (${response.status}).`,
      );
    }
    return payload as T;
  }

  private async resolveBoundAccess(teamId?: string): Promise<Access> {
    const access = await this.resolveAccess(teamId);
    if (teamId && access.teamId !== teamId) {
      throw new Error("OpenPond Managed resolved a different workspace than the execution.");
    }
    return access;
  }

  private trainingClient(access: Access) {
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    return createTrainingClient({
      baseUrl: access.apiBaseUrl,
      fetch: this.fetchImpl,
      headers,
    });
  }

  private async syncProjectForSubmission(
    project: import("@openpond/contracts").ModelProject,
    access: Access,
  ) {
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    const client = createModelProjectsClient({
      baseUrl: access.apiBaseUrl,
      fetch: this.fetchImpl,
      headers,
    });
    const hosted = await client.upsert({
      schemaVersion: "openpond.hostedModelProjectSync.v2",
      portableProjectId: project.id,
      name: project.name,
      objective: project.objective,
      defaultBaseModel: project.defaultBaseModel,
      defaultDestinationId: project.defaultDestinationId,
      trainingSetup: project.trainingSetup,
      sourceRevision: project.revision,
      sourceUpdatedAt: project.updatedAt,
      expectedEtag: project.hosted?.teamId === access.teamId ? project.hosted.etag : null,
    });
    const syncedAt = new Date().toISOString();
    const saved = ModelProjectSchema.parse({
      ...project,
      hosted: {
        schemaVersion: "openpond.hostedModelProjectLink.v1",
        teamId: access.teamId,
        projectId: hosted.id,
        portableProjectId: hosted.portableProjectId,
        revision: hosted.revision,
        etag: hosted.etag,
        syncedSourceRevision: project.revision,
        syncedAt,
        tasksets: project.hosted?.teamId === access.teamId ? project.hosted.tasksets : [],
      },
    });
    await this.dependencies.store.saveModelProject(saved);
    return saved;
  }

  private ensureLocalExecutor(
    ref: TrainingExecutionRef,
    access: Access,
    harnessReleaseHash?: string,
  ): void {
    if (this.localExecutors.has(ref.runId)) return;
    if (!harnessReleaseHash) {
      throw new Error("Managed local rollout is missing its Harness release hash.");
    }
    const executor = new ManagedRlLocalRolloutExecutor({
      runId: ref.runId,
      access,
      fetchImpl: this.fetchImpl,
      env: this.dependencies.env,
      store: this.dependencies.store,
      storeDir: this.dependencies.storeDir,
      harnessRoot: path.join(
        this.dependencies.storeDir,
        "training",
        "harnesses",
        harnessReleaseHash,
        "source",
      ),
    });
    this.localExecutors.set(ref.runId, executor);
    executor.start();
  }
}
