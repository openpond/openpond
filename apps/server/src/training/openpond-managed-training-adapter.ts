import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AdapterValidationReceiptSchema,
  TrainingArtifactsSchema,
  TrainingEngineCapabilitiesSchema,
  TrainingExecutionStatusSchema,
  type AdapterValidationReceipt,
  type LearningSignalBatch,
  type ResolvedTrainingPlan,
  type TrainingArtifacts,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
} from "@openpond/contracts";
import type { ModelImprovementQualificationReceipt } from "@openpond/evals";
import { withVercelProtectionBypass } from "@openpond/cloud";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { TrainingEngineAdapter } from "@openpond/training-sdk";

import type { SqliteStore } from "../store/store.js";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";
import { ManagedRlLocalRolloutExecutor } from "./managed-rl-local-rollout-executor.js";
import { supportsManagedRlHarness } from "./managed-rl-harness-registry.js";
import {
  parseManagedJobDetail,
  persistManagedRunEvidence,
} from "./openpond-managed-run-evidence.js";

const ADAPTER_ID = "sandbox-managed-rl";
const QUALIFIED_MODEL = {
  source: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
} as const;
const QUALIFIED_RECIPE = {
  loraRank: 16,
  rolloutGroupSize: 4,
  rolloutConcurrency: 4,
  maxPromptTokens: 4_096,
} as const;

type Access = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

type ManagedJob = {
  id: string;
  state: string;
  version: number;
  completedGroups?: number;
  targetGroups?: number;
  terminalReason?: string | null;
  createdAt: string;
  updatedAt: string;
  resources?: Array<{
    kind: string;
    state: string;
    metadata: Record<string, unknown>;
  }>;
  inputBundle?: {
    rewardModelTraining?: Record<string, unknown>;
    harnessRelease?: {
      contentHash?: string;
    };
    harnessRunManifest?: {
      runtimeTarget?: {
        placement?: string;
      };
    } & Record<string, unknown>;
  };
  cleanupAttestation?: unknown;
};

type ManagedCandidateBundle = {
  jobId: string;
  artifact: {
    modelArtifactId: string;
    uri: string;
    sha256: string;
    sizeBytes: number;
  };
};

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

  /** Uploads an immutable rendered artifact for a managed Reward Model run. */
  async uploadRewardModelArtifact(input: {
    bytes: Uint8Array;
    mediaType: string;
    idempotencyKey: string;
  }) {
    const bytes = Buffer.from(input.bytes);
    return this.requestJson<{
      objectRef: string;
      sha256: string;
      sizeBytes: number;
      mediaType: string;
    }>(
      "/v1/managed-rl/reward-model-artifacts",
      {
        method: "POST",
        body: JSON.stringify({
          contentBase64: bytes.toString("base64"),
          expectedSha256: sha256(bytes),
          idempotencyKey: input.idempotencyKey,
          mediaType: input.mediaType,
        }),
      },
      await this.resolveBoundAccess(),
    );
  }

  async createRewardModelLaunch(request: unknown) {
    return this.requestJson<{ job: ManagedJob; requestHash: string }>(
      "/v1/managed-rl/reward-model-launches",
      { method: "POST", body: JSON.stringify(request) },
      await this.resolveBoundAccess(),
    );
  }

  async rewardModelJob(jobId: string) {
    const payload = await this.requestJson<{
      job: {
        job: ManagedJob;
        resources: Array<{
          kind: string;
          state: string;
          metadata: Record<string, unknown>;
        }>;
      };
    }>(
      `/v1/managed-rl/jobs/${encodeURIComponent(jobId)}`,
      {},
      await this.resolveBoundAccess(),
    );
    return payload.job;
  }

  async capabilities() {
    const checkedAt = new Date().toISOString();
    return TrainingEngineCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingEngineCapabilities.v1",
      adapterId: this.id,
      available: true,
      methods: ["grpo"],
      signalKinds: ["trajectory", "reward", "grader_evidence", "infrastructure_failure"],
      modelFamilies: ["transformers"],
      precisions: ["bf16"],
      topologies: ["single_gpu_phased"],
      workerProtocolVersion: "openpond.managedRlWorker.v2",
      upstreamRevision: "e0d60e4d85ea636873acb2e7083e794740d20226",
      workerImageDigest: null,
      capabilityReceipt: contentHash({
        adapterId: this.id,
        contract: "openpond.managedRlPortableSubmission.v1",
        qualifiedModel: QUALIFIED_MODEL,
      }),
      checkedAt,
      unavailableReason: null,
    });
  }

  async validate(plan: ResolvedTrainingPlan): Promise<AdapterValidationReceipt> {
    const issues: AdapterValidationReceipt["issues"] = [];
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
    if (
      plan.manifest.model.source !== QUALIFIED_MODEL.source ||
      plan.manifest.model.revision !== QUALIFIED_MODEL.revision ||
      plan.manifest.model.tokenizerRevision !== QUALIFIED_MODEL.revision ||
      plan.manifest.model.chatTemplateHash !== QUALIFIED_MODEL.chatTemplateHash
    ) {
      issues.push({
        code: "managed_base_profile_unsupported",
        path: "manifest.model",
        message: "OpenPond Managed currently requires the qualified Qwen3-0.6B profile.",
      });
    }
    if (plan.recipe.method !== "grpo") {
      issues.push({
        code: "managed_method_unsupported",
        path: "recipe.method",
        message: "OpenPond Managed currently accepts GRPO runs.",
      });
    } else if (
      plan.recipe.lora.rank !== QUALIFIED_RECIPE.loraRank ||
      plan.recipe.rollout.groupSize !== QUALIFIED_RECIPE.rolloutGroupSize ||
      plan.recipe.rollout.concurrency !== QUALIFIED_RECIPE.rolloutConcurrency ||
      plan.recipe.dataset.maxPromptTokens !== QUALIFIED_RECIPE.maxPromptTokens
    ) {
      issues.push({
        code: "managed_recipe_profile_unsupported",
        path: "recipe",
        message:
          "OpenPond Managed requires the qualified 0.6B recipe profile: LoRA rank 16, group size 4, rollout concurrency 4, and 4096 prompt tokens.",
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
            scoredTasks.some(
              (task) =>
                typeof task.expectedOutput?.artifactRendererRef !== "string" ||
                typeof task.expectedOutput?.outputSchemaRef !== "string",
            )
          ) {
            issues.push({
              code: "managed_learned_reward_renderer_missing",
              path: "taskset.tasks",
              message:
                "Stateless learned-reward tasks require an artifact renderer and output schema.",
            });
          } else if (
            !learnedPreference &&
            scoredTasks.some(
              (task) => typeof task.expectedOutput?.text !== "string",
            )
          ) {
            issues.push({
              code: "managed_exact_answer_missing",
              path: "taskset.tasks",
              message:
                "Stateless exact-reward tasks require an exact expected text answer.",
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
    const submission = {
      schemaVersion: "openpond.managedRlPortableSubmission.v1" as const,
      sourceRunRef: `openpond:model-run:${plan.manifest.id}`,
      name: `OpenPond Managed · ${trainingPlan.modelId}`.slice(0, 191),
      idempotencyKey: `openpond-managed:${plan.manifest.contentHash}`.slice(0, 191),
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
    };
    const access = await this.resolveBoundAccess();
    const response = await this.requestJson<{
      job: ManagedJob;
      sourceManifestHash: string;
      submissionHash: string;
    }>(
      "/v1/managed-rl/portable-launches",
      {
        method: "POST",
        body: JSON.stringify(submission),
      },
      access,
    );
    const ref = {
      runId: response.job.id,
      adapterId: this.id,
      providerJobId: response.job.id,
      tenantId: access.teamId,
      leaseId: null,
      manifestHash: response.sourceManifestHash,
      inputBundleHash: response.submissionHash,
      createdAt: dateString(response.job.createdAt),
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
    const payload = await this.requestJson<{ job: unknown }>(
      `/v1/managed-rl/jobs/${encodeURIComponent(ref.runId)}`,
      {},
      await this.resolveBoundAccess(ref.tenantId),
    );
    const detail = parseManagedJobDetail(payload.job);
    await persistManagedRunEvidence({
      store: this.dependencies.store,
      ref,
      detail,
    }).catch(() => undefined);
    const placement =
      detail.job.inputBundle?.harnessRunManifest?.runtimeTarget?.placement;
    if (placement === "local") {
      const localJob = await this.dependencies.store.getTrainingJob(ref.runId);
      const storedHarnessHash = localJob?.metadata.harnessReleaseHash;
      this.ensureLocalExecutor(
        ref,
        await this.resolveBoundAccess(ref.tenantId),
        detail.job.inputBundle?.harnessRelease?.contentHash
          ?? detail.job.inputBundle?.harnessRunManifest?.harnessRelease?.contentHash
          ?? (typeof storedHarnessHash === "string" ? storedHarnessHash : undefined),
      );
    }
    if (
      ["completed", "cancelled", "budget_exhausted", "failed"].includes(
        detail.job.state,
      )
    ) {
      const executor = this.localExecutors.get(ref.runId);
      this.localExecutors.delete(ref.runId);
      void executor?.stop();
    }
    return TrainingExecutionStatusSchema.parse(toExecutionStatus(detail.job));
  }

  async refreshEvidence(ref: TrainingExecutionRef): Promise<void> {
    const payload = await this.requestJson<{ job: unknown }>(
      `/v1/managed-rl/jobs/${encodeURIComponent(ref.runId)}`,
      {},
      await this.resolveBoundAccess(ref.tenantId),
    );
    await persistManagedRunEvidence({
      store: this.dependencies.store,
      ref,
      detail: parseManagedJobDetail(payload.job),
    });
  }

  async logs(ref: TrainingExecutionRef, cursor?: string) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.requestJson<{
      cursor: string;
      entries: Array<{
        timestamp: string;
        level: string;
        message: string;
      }>;
    }>(
      `/v1/managed-rl/jobs/${encodeURIComponent(ref.runId)}/logs${query}`,
      {},
      await this.resolveBoundAccess(ref.tenantId),
    );
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    const executor = this.localExecutors.get(ref.runId);
    this.localExecutors.delete(ref.runId);
    void executor?.stop();
    const access = await this.resolveBoundAccess(ref.tenantId);
    const current = await this.requestJson<{ job: unknown }>(
      `/v1/managed-rl/jobs/${encodeURIComponent(ref.runId)}`,
      {},
      access,
    );
    const detail = parseManagedJobDetail(current.job);
    await this.requestJson(
      `/v1/managed-rl/jobs/${encodeURIComponent(ref.runId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: detail.job.version }),
      },
      access,
    );
  }

  async close(): Promise<void> {
    const executors = [...this.localExecutors.values()];
    this.localExecutors.clear();
    await Promise.all(executors.map((executor) => executor.stop()));
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const payload = await this.requestJson<{
      candidateBundle: ManagedCandidateBundle | null;
    }>(
      `/v1/managed-rl/jobs/${encodeURIComponent(ref.runId)}/artifacts`,
      {},
      await this.resolveBoundAccess(ref.tenantId),
    );
    const candidate = payload.candidateBundle;
    if (
      !candidate ||
      candidate.jobId !== ref.runId ||
      !candidate.artifact.modelArtifactId.trim() ||
      !candidate.artifact.uri.startsWith("r2://") ||
      !/^[a-f0-9]{64}$/.test(candidate.artifact.sha256) ||
      !Number.isSafeInteger(candidate.artifact.sizeBytes) ||
      candidate.artifact.sizeBytes <= 0
    ) {
      throw new Error("Sandbox completed managed training without a valid candidate artifact.");
    }
    const artifacts = [
      {
        kind: "adapter" as const,
        objectRef:
          `sandbox-managed-rl://${encodeURIComponent(ref.runId)}/` +
          encodeURIComponent(candidate.artifact.modelArtifactId),
        sha256: candidate.artifact.sha256,
        sizeBytes: candidate.artifact.sizeBytes,
      },
    ];
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
    const headers = withVercelProtectionBypass(
      requestUrl,
      hostedApiAuthHeaders(access.token),
      this.dependencies.env,
    );
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

async function managedQualification(input: {
  store: SqliteStore;
  taskset: { metadata: Record<string, unknown> };
  qualificationRef: { id: string; contentHash: string } | null;
}): Promise<ModelImprovementQualificationReceipt | null> {
  if (!input.qualificationRef) return null;
  const lineage = input.taskset.metadata.harnessEvaluationLineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  const review = (lineage as { review?: unknown }).review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const workspaceId = (review as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  const receipts = await input.store.listHarnessImprovementArtifacts(
    workspaceId,
    "training_qualification",
    1_000,
  ) as ModelImprovementQualificationReceipt[];
  return receipts.find((receipt) =>
    receipt.id === input.qualificationRef!.id &&
    receipt.contentHash === input.qualificationRef!.contentHash,
  ) ?? null;
}

function dateString(value: string | Date): string {
  return new Date(value).toISOString();
}

function toExecutionStatus(job: ManagedJob) {
  const terminal = new Set(["completed", "cancelled", "budget_exhausted", "failed"]);
  const preparing = new Set([
    "draft",
    "validating",
    "admitted",
    "provisioning_gpu",
    "provisioning_rollouts",
  ]);
  const state =
    job.state === "completed"
      ? ("succeeded" as const)
      : job.state === "cancelled"
        ? ("cancelled" as const)
        : job.state === "failed" || job.state === "budget_exhausted"
          ? ("failed" as const)
          : job.state === "cancelling"
            ? ("cancelling" as const)
            : preparing.has(job.state)
              ? ("preparing" as const)
              : ("running" as const);
  const progress = terminal.has(job.state)
    ? 1
    : typeof job.completedGroups === "number" &&
        typeof job.targetGroups === "number" &&
        job.targetGroups > 0
      ? job.completedGroups / job.targetGroups
      : null;
  return {
    runId: job.id,
    state,
    phase: job.state,
    progress,
    updatedAt: dateString(job.updatedAt),
    errorCode:
      state === "failed"
        ? (job.terminalReason?.trim() || "managed_training_failed")
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .slice(0, 191)
        : null,
  };
}
