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
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { TrainingEngineAdapter } from "@openpond/training-sdk";

import type { SqliteStore } from "../store/store.js";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";

const ADAPTER_ID = "sandbox-managed-rft";
const QUALIFIED_MODEL = {
  source: "Qwen/Qwen3-0.6B",
  revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  chatTemplateHash:
    "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
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
};

type ManagedJobDetail = {
  job: ManagedJob;
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
};

export class OpenPondManagedTrainingAdapter
  implements TrainingEngineAdapter
{
  readonly id = ADAPTER_ID;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAccess: (teamId?: string) => Promise<Access>;
  private readonly readFileImpl: typeof readFile;

  constructor(
    private readonly dependencies: OpenPondManagedTrainingAdapterDependencies,
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.resolveAccess =
      dependencies.resolveAccess ??
      ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
    this.readFileImpl = dependencies.readFileImpl ?? readFile;
  }

  async capabilities() {
    const checkedAt = new Date().toISOString();
    return TrainingEngineCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingEngineCapabilities.v1",
      adapterId: this.id,
      available: true,
      methods: ["grpo"],
      signalKinds: [
        "trajectory",
        "reward",
        "grader_evidence",
        "infrastructure_failure",
      ],
      modelFamilies: ["transformers"],
      precisions: ["bf16"],
      topologies: ["single_gpu_phased"],
      workerProtocolVersion: "openpond.managedRftWorker.v2",
      upstreamRevision:
        "e0d60e4d85ea636873acb2e7083e794740d20226",
      workerImageDigest: null,
      capabilityReceipt: contentHash({
        adapterId: this.id,
        contract: "openpond.managedRftPortableSubmission.v1",
        qualifiedModel: QUALIFIED_MODEL,
      }),
      checkedAt,
      unavailableReason: null,
    });
  }

  async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    const issues: AdapterValidationReceipt["issues"] = [];
    if (
      plan.engine.adapterId !== this.id ||
      plan.compute.adapterId !== "openpond-managed" ||
      plan.runtime.adapterId !== "openpond-managed-harness"
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
      plan.manifest.model.chatTemplateHash !==
        QUALIFIED_MODEL.chatTemplateHash
    ) {
      issues.push({
        code: "managed_base_profile_unsupported",
        path: "manifest.model",
        message:
          "OpenPond Managed currently requires the qualified Qwen3-0.6B profile.",
      });
    }
    if (plan.recipe.method !== "grpo") {
      issues.push({
        code: "managed_method_unsupported",
        path: "recipe.method",
        message: "OpenPond Managed currently accepts GRPO runs.",
      });
    }
    if (!plan.execution) {
      issues.push({
        code: "managed_execution_context_missing",
        path: "execution",
        message:
          "OpenPond Managed requires a persisted plan and approval.",
      });
    } else {
      const [trainingPlan, approval] = await Promise.all([
        this.dependencies.store.getTrainingPlan(
          plan.execution.trainingPlanId,
        ),
        this.dependencies.store.getTrainingApproval(
          plan.execution.approvalId,
        ),
      ]);
      if (
        !trainingPlan ||
        !approval ||
        trainingPlan.destinationId !== "openpond_managed" ||
        approval.planId !== trainingPlan.id ||
        approval.destinationId !== "openpond_managed" ||
        contentHash(approval) !== plan.approvalHash ||
        approval.maximumCostUsd !== plan.maximumSpendUsd
      ) {
        issues.push({
          code: "managed_approval_changed",
          path: "execution",
          message:
            "The persisted OpenPond Managed plan or approval changed.",
        });
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
    const taskset = await this.dependencies.store.getTaskset(
      trainingPlan.tasksetId,
    );
    if (!taskset) {
      throw new Error("The managed training Taskset is no longer available.");
    }
    const validationTasks = taskset.tasks.filter(
      (task) => task.split === "frozen_eval" || task.split === "validation",
    );
    if (validationTasks.length === 0) {
      throw new Error(
        "OpenPond Managed requires at least one private validation task.",
      );
    }
    const bundleDirectory = path.join(
      this.dependencies.storeDir,
      "training",
      "portable-releases",
      "resolved-bundles",
      plan.manifest.resolvedBundleHash,
    );
    const bundleManifest = JSON.parse(
      await this.readFileImpl(
        path.join(bundleDirectory, "bundle-manifest.json"),
        "utf8",
      ),
    ) as {
      files: Array<{ path: string; sha256: string; sizeBytes: number }>;
      contentHash: string;
    };
    if (bundleManifest.contentHash !== plan.manifest.resolvedBundleHash) {
      throw new Error("The managed resolved bundle changed before upload.");
    }
    const files = await Promise.all(
      bundleManifest.files.map(async (file) => {
        const value = await this.readFileImpl(
          path.join(bundleDirectory, file.path),
        );
        if (
          value.byteLength !== file.sizeBytes ||
          sha256(value) !== file.sha256
        ) {
          throw new Error(
            `Managed training bundle file ${file.path} changed before upload.`,
          );
        }
        return {
          ...file,
          encoding: "base64" as const,
          content: value.toString("base64"),
        };
      }),
    );
    const submission = {
      schemaVersion: "openpond.managedRftPortableSubmission.v1" as const,
      sourceRunRef: `openpond:model-run:${plan.manifest.id}`,
      name: `OpenPond Managed · ${trainingPlan.modelId}`.slice(0, 191),
      idempotencyKey:
        `openpond-managed:${plan.manifest.contentHash}`.slice(0, 191),
      manifest: plan.manifest,
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
    }>("/v1/managed-rft/portable-launches", {
      method: "POST",
      body: JSON.stringify(submission),
    }, access);
    return {
      runId: response.job.id,
      adapterId: this.id,
      providerJobId: response.job.id,
      tenantId: access.teamId,
      leaseId: null,
      manifestHash: response.sourceManifestHash,
      inputBundleHash: response.submissionHash,
      createdAt: dateString(response.job.createdAt),
    };
  }

  async consumeSignals(
    _ref: TrainingExecutionRef,
    _batch: LearningSignalBatch,
  ): Promise<void> {
    throw new Error(
      "OpenPond Managed consumes the immutable submitted training bundle.",
    );
  }

  async status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    const payload = await this.requestJson<{ job: ManagedJobDetail }>(
      `/v1/managed-rft/jobs/${encodeURIComponent(ref.runId)}`,
      {},
      await this.resolveBoundAccess(ref.tenantId),
    );
    return TrainingExecutionStatusSchema.parse(
      toExecutionStatus(payload.job.job),
    );
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
      `/v1/managed-rft/jobs/${encodeURIComponent(ref.runId)}/logs${query}`,
      {},
      await this.resolveBoundAccess(ref.tenantId),
    );
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    const access = await this.resolveBoundAccess(ref.tenantId);
    const current = await this.requestJson<{ job: ManagedJobDetail }>(
      `/v1/managed-rft/jobs/${encodeURIComponent(ref.runId)}`,
      {},
      access,
    );
    await this.requestJson(
      `/v1/managed-rft/jobs/${encodeURIComponent(ref.runId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: current.job.job.version }),
      },
      access,
    );
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const payload = await this.requestJson<{
      candidateBundle: ManagedCandidateBundle | null;
    }>(
      `/v1/managed-rft/jobs/${encodeURIComponent(ref.runId)}/artifacts`,
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
      throw new Error(
        "Sandbox completed managed training without a valid candidate artifact.",
      );
    }
    const artifacts = [
      {
        kind: "adapter" as const,
        objectRef:
          `sandbox-managed-rft://${encodeURIComponent(ref.runId)}/` +
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
    const access = suppliedAccess ?? await this.resolveBoundAccess();
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(
      `${access.apiBaseUrl}${pathname}`,
      { ...init, headers },
    );
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
      throw new Error(
        "OpenPond Managed resolved a different workspace than the execution.",
      );
    }
    return access;
  }
}

function dateString(value: string | Date): string {
  return new Date(value).toISOString();
}

function toExecutionStatus(job: ManagedJob) {
  const terminal = new Set([
    "completed",
    "cancelled",
    "budget_exhausted",
    "failed",
  ]);
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
  const progress =
    terminal.has(job.state)
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
