import type {
  CreateImproveRun,
  OpenPondProfileState,
  TrainingJob,
  TrainingStateResponse,
} from "@openpond/contracts";
import {
  conciseWorkproductName,
  managedAdapterCustomerBindingAllowed,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

import {
  statusLabel,
  trainingModelRows,
} from "../training/training-model-data";

export type LabWorkproductKind = "agent" | "skill" | "extension" | "model";

export type LabWorkproductSummary = {
  key: string;
  kind: LabWorkproductKind;
  id: string;
  ownerProfileId: string | null;
  name: string;
  description: string;
  status: string;
  updatedAt: string;
  path: string | null;
  enabled: boolean | null;
  runIds: string[];
  conversationId: string | null;
  tasksetId: string | null;
  trainingRunCount: number;
  evaluationStatus: "not_run" | "passed" | "failed";
  useActionId: string | null;
  skillSource?: "profile" | "codex";
  skillValidationStatus?: "valid" | "warning" | "error";
  skillValidationMessages?: string[];
  skillSourceHash?: string;
  skillCharCount?: number;
  skillResourceFiles?: string[];
};

const COMPLETED_RUN_STATES = new Set<CreateImproveRun["state"]>([
  "released",
  "rejected",
  "ready",
  "ready_local",
  "published_hosted",
  "cancelled",
]);

export function labWorkproductProjection(input: {
  profile: OpenPondProfileState | null;
  training: TrainingStateResponse | null;
  runs: CreateImproveRun[];
}): LabWorkproductSummary[] {
  const byKey = new Map<string, LabWorkproductSummary>();
  const stableModelProjectIds = new Set(
    (input.training?.modelProjects ?? []).map((project) => project.id)
  );
  const jobIdsByModelId = new Map<string, Set<string>>();
  const planModelById = new Map(
    (input.training?.plans ?? []).map(
      (plan) => [plan.id, plan.modelId] as const
    )
  );
  for (const job of input.training?.jobs ?? []) {
    const modelId = planModelById.get(job.planId);
    if (!modelId) continue;
    const jobIds = jobIdsByModelId.get(modelId) ?? new Set<string>();
    jobIds.add(job.id);
    jobIdsByModelId.set(modelId, jobIds);
  }
  for (const run of input.runs) {
    if (
      run.target.kind !== "model" ||
      !run.target.id ||
      !run.target.trainingPlanId
    )
      continue;
    const jobIds = jobIdsByModelId.get(run.target.id) ?? new Set<string>();
    for (const job of input.training?.jobs ?? []) {
      if (job.planId === run.target.trainingPlanId) jobIds.add(job.id);
    }
    jobIdsByModelId.set(run.target.id, jobIds);
  }
  const timestamp = new Date(0).toISOString();

  for (const agent of input.profile?.agents ?? []) {
    const key = workproductKey("agent", agent.id);
    const defaultChatAction =
      input.profile?.actionCatalog.find(
        (action) =>
          action.agentId === agent.id &&
          action.sourceActionId === "chat" &&
          action.visibility !== "internal" &&
          action.visibility !== "debug"
      ) ?? null;
    byKey.set(key, {
      key,
      kind: "agent",
      id: agent.id,
      ownerProfileId: input.profile?.activeProfile ?? null,
      name: agent.name || agent.id,
      description: agent.enabled
        ? "Enabled Profile Agent"
        : "Disabled Profile Agent",
      status: agent.enabled ? "Ready" : "Disabled",
      updatedAt: input.profile?.lastCheck?.checkedAt ?? timestamp,
      path: agent.path,
      enabled: agent.enabled,
      runIds: [],
      conversationId: null,
      tasksetId: null,
      trainingRunCount: 0,
      evaluationStatus: "not_run",
      useActionId: defaultChatAction?.id ?? null,
    });
  }

  for (const skill of input.profile?.skills ?? []) {
    const key = workproductKey("skill", skill.name);
    byKey.set(key, {
      key,
      kind: "skill",
      id: skill.name,
      ownerProfileId: input.profile?.activeProfile ?? null,
      name: skill.name,
      description: skill.description,
      status:
        skill.validationStatus === "valid" ? "Ready" : skill.validationStatus,
      updatedAt: timestamp,
      path: skill.path,
      enabled: skill.enabled,
      runIds: [],
      conversationId: null,
      tasksetId: null,
      trainingRunCount: 0,
      evaluationStatus: "not_run",
      useActionId: null,
      skillSource: "profile",
      skillValidationStatus: skill.validationStatus,
      skillValidationMessages: skill.validationMessages,
      skillSourceHash: skill.sourceHash,
      skillCharCount: skill.charCount,
      skillResourceFiles: skill.resourceFiles,
    });
  }

  for (const project of input.training?.modelProjects ?? []) {
    const drafts = (input.training?.modelRunDrafts ?? []).filter(
      (draft) =>
        draft.modelId === project.id &&
        (draft.status === "draft" || draft.status === "ready_to_run")
    );
    const latestDraft = drafts[0] ?? null;
    const lifecycleRuns = (input.training?.modelRuns ?? [])
      .filter((run) => run.modelId === project.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latestLifecycleRun = lifecycleRuns[0] ?? null;
    const baseVersion =
      (input.training?.modelVersions ?? []).find(
        (version) =>
          version.modelId === project.id &&
          version.kind === "base_reference" &&
          version.version === 0
      ) ?? null;
    const key = workproductKey("model", project.id);
    byKey.set(key, {
      key,
      kind: "model",
      id: project.id,
      ownerProfileId: project.profileId,
      name: conciseWorkproductName(project.name, "Untitled Model"),
      description:
        project.objective ??
        "Configure this Model and run its first training job.",
      status: latestLifecycleRun
        ? lifecycleModelRunStatus(latestLifecycleRun.status)
        : latestDraft?.status === "ready_to_run"
        ? "Ready to run"
        : latestDraft
        ? "Draft"
        : baseVersion
        ? "Base ready"
        : "Ready",
      updatedAt:
        latestLifecycleRun?.updatedAt ??
        latestDraft?.updatedAt ??
        project.updatedAt,
      path: latestLifecycleRun
        ? `tasksets/${latestLifecycleRun.taskset.id}`
        : latestDraft?.tasksetRef
        ? `tasksets/${latestDraft.tasksetRef.id}`
        : baseVersion
        ? `tasksets/${baseVersion.taskset.id}`
        : null,
      enabled: baseVersion ? false : null,
      runIds: [],
      conversationId: null,
      tasksetId:
        latestLifecycleRun?.taskset.id ??
        latestDraft?.tasksetRef?.id ??
        baseVersion?.taskset.id ??
        null,
      trainingRunCount: drafts.length + lifecycleRuns.length,
      evaluationStatus: "not_run",
      useActionId: null,
    });
  }

  for (const row of trainingModelRows(input.training)) {
    if (
      row.taskset.metadata.resourceIntent === "dataset" &&
      !row.latestPlan &&
      !row.localModel
    ) {
      continue;
    }
    const modelRun =
      input.runs
        .filter(
          (run) =>
            run.target.kind === "model" &&
            ((row.latestPlan &&
              run.target.trainingPlanId === row.latestPlan.id) ||
              (!row.latestPlan &&
                row.localModel &&
                run.target.trainingJobId === row.localModel.jobId))
        )
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt)
        )[0] ?? null;
    const modelId =
      modelRun?.target.kind === "model" && modelRun.target.id
        ? modelRun.target.id
        : row.latestPlan?.modelId ?? row.localModel?.modelId ?? null;
    if (!modelId) continue;
    const key = workproductKey("model", modelId);
    const existing = byKey.get(key);
    const linkedPlanId =
      modelRun?.target.kind === "model" ? modelRun.target.trainingPlanId : null;
    const modelPlanIds = new Set(
      (input.training?.plans ?? [])
        .filter(
          (plan) =>
            plan.modelId === modelId ||
            (linkedPlanId != null && plan.id === linkedPlanId)
        )
        .map((plan) => plan.id)
    );
    const modelJobs = (input.training?.jobs ?? [])
      .filter((job) => modelPlanIds.has(job.planId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const latestModelJob = modelJobs[0] ?? null;
    const latestModelLineage = latestModelJob
      ? input.training?.models.find(
          (model) => model.jobId === latestModelJob.id
        ) ?? null
      : null;
    byKey.set(key, {
      key,
      kind: "model",
      id: modelId,
      ownerProfileId: existing?.ownerProfileId ?? row.taskset.profileId,
      name: conciseWorkproductName(
        existing?.name ?? modelRun?.target.displayName ?? row.name,
        "New model"
      ),
      description: existing?.description ?? row.taskset.objective,
      status: latestModelJob ? statusLabel(latestModelJob.status) : row.status,
      updatedAt: latestModelJob?.updatedAt ?? row.updatedAt,
      path: `tasksets/${row.taskset.id}`,
      enabled: row.localModel
        ? row.localModel.status === "imported" &&
          Boolean(resolveModelBindingPromotionGate(row.localModel))
        : null,
      runIds: modelRun
        ? [...new Set([...(existing?.runIds ?? []), modelRun.id])]
        : existing?.runIds ?? [],
      conversationId: null,
      tasksetId: row.taskset.id,
      trainingRunCount: Math.max(
        existing?.trainingRunCount ?? 0,
        modelJobs.length
      ),
      evaluationStatus: modelJobEvaluationStatus(
        latestModelJob,
        latestModelLineage
      ),
      useActionId: null,
    });
  }

  for (const run of input.runs) {
    if (run.target.kind === "agent") continue;
    if (run.target.kind === "configuration" || run.target.kind === "unselected")
      continue;
    if (
      run.target.kind === "model" &&
      !run.tasksetRef &&
      ["cancelled", "failed", "rejected"].includes(run.state)
    ) {
      continue;
    }
    if (run.target.kind === "model" && !run.target.id) continue;
    const kind = run.target.kind;
    const id =
      run.target.kind === "model" ? run.target.id! : run.target.id ?? run.id;
    const key = workproductKey(kind, id);
    const existing = byKey.get(key);
    const candidateName =
      kind === "model" && stableModelProjectIds.has(id)
        ? existing?.name ?? run.target.displayName ?? draftName(run)
        : run.target.displayName ?? existing?.name ?? draftName(run);
    const name =
      kind === "model"
        ? conciseWorkproductName(candidateName, "New model")
        : candidateName;
    byKey.set(key, {
      key,
      kind,
      id,
      ownerProfileId: existing?.ownerProfileId ?? run.scope.profileId,
      name,
      description: existing?.description ?? run.objective,
      status: runStatusLabel(run),
      updatedAt: newer(existing?.updatedAt, run.updatedAt),
      path: existing?.path ?? run.plan?.sourcePlan[0]?.path ?? null,
      enabled: existing?.enabled ?? null,
      runIds: [...new Set([...(existing?.runIds ?? []), run.id])],
      conversationId:
        run.scope.conversationId ?? existing?.conversationId ?? null,
      tasksetId:
        run.target.kind === "model"
          ? run.tasksetRef?.id ?? existing?.tasksetId ?? null
          : null,
      trainingRunCount:
        kind === "model"
          ? Math.max(
              existing?.trainingRunCount ?? 0,
              jobIdsByModelId.get(id)?.size ?? 0
            )
          : existing?.trainingRunCount ?? 0,
      evaluationStatus:
        runEvaluationStatus(run) ?? existing?.evaluationStatus ?? "not_run",
      useActionId: existing?.useActionId ?? null,
    });
  }

  return [...byKey.values()].sort((left, right) => {
    const activeDelta =
      Number(hasActiveRun(left, input.runs)) -
      Number(hasActiveRun(right, input.runs));
    if (activeDelta !== 0) return -activeDelta;
    return (
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.name.localeCompare(right.name)
    );
  });
}


function lifecycleModelRunStatus(
  status: "prepared" | "running" | "succeeded" | "failed" | "cancelled"
): string {
  if (status === "prepared") return "Prepared";
  if (status === "running") return "Running";
  if (status === "succeeded") return "Rollout complete";
  if (status === "failed") return "Failed";
  return "Cancelled";
}

export function workproductKey(kind: LabWorkproductKind, id: string): string {
  return `${kind}:${id}`;
}

export function labWorkproductKindLabel(kind: LabWorkproductKind): string {
  if (kind === "agent") return "Agents";
  if (kind === "skill") return "Skills";
  if (kind === "extension") return "Extensions";
  return "Models";
}

export function runsForWorkproduct(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[]
): CreateImproveRun[] {
  const ids = new Set(workproduct.runIds);
  return runs
    .filter((run) => ids.has(run.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function hasActiveRun(
  workproduct: LabWorkproductSummary,
  runs: CreateImproveRun[]
): boolean {
  const ids = new Set(workproduct.runIds);
  return runs.some(
    (run) => ids.has(run.id) && !COMPLETED_RUN_STATES.has(run.state)
  );
}

function draftName(run: CreateImproveRun): string {
  const prefix = run.operation === "improve" ? "Improve" : "Create";
  return `${prefix} ${run.target.kind}`;
}

function runStatusLabel(run: CreateImproveRun): string {
  return run.state.replaceAll("_", " ");
}

function runEvaluationStatus(
  run: CreateImproveRun
): LabWorkproductSummary["evaluationStatus"] | null {
  const receipts = run.evaluationReceipts.filter(
    (receipt) =>
      receipt.subject === "candidate" || receipt.subject === "post_release"
  );
  if (!receipts.length) return null;
  if (
    receipts.some(
      (receipt) =>
        receipt.status === "failed" ||
        receipt.status === "blocked" ||
        receipt.publishGate === "failed"
    )
  ) {
    return "failed";
  }
  return receipts.every(
    (receipt) => receipt.status === "passed" && receipt.publishGate !== "failed"
  )
    ? "passed"
    : null;
}

function modelJobEvaluationStatus(
  job: TrainingJob | null,
  lineage: TrainingStateResponse["models"][number] | null
): LabWorkproductSummary["evaluationStatus"] {
  if (!job) return "not_run";
  const complete =
    Boolean(lineage && resolveModelBindingPromotionGate(lineage)) ||
    job.metadata.frozenEvaluationComplete === true ||
    Boolean(lineage?.frozenEvaluationArtifactId) ||
    Boolean(lineage?.managedServing?.customerBindingAllowed);
  if (!complete) return "not_run";
  const passed = Boolean(
    lineage &&
      (resolveModelBindingPromotionGate(lineage) ||
        managedAdapterCustomerBindingAllowed(lineage))
  );
  return passed ? "passed" : "failed";
}

function newer(left: string | undefined, right: string): string {
  if (!left) return right;
  return left.localeCompare(right) >= 0 ? left : right;
}
