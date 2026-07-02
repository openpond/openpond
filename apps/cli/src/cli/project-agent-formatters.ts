import type {
  SandboxAgent,
  SandboxCodingWorkItem,
  SandboxCodingWorkItemActivity,
  SandboxProject,
} from "../sandbox/types/index";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalStringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalStringArrayField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function optionalRecordField(
  record: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const value = record?.[key];
  return isJsonRecord(value) ? value : null;
}

function optionalRecordArrayField(
  record: Record<string, unknown> | null | undefined,
  key: string
): Array<Record<string, unknown>> {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonRecord);
}

function optionalBooleanField(
  record: Record<string, unknown> | null | undefined,
  key: string
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function activityPayloads(
  activity: SandboxCodingWorkItemActivity[]
): Record<string, unknown>[] {
  return activity
    .map((item) => item.payload)
    .filter(isJsonRecord);
}

function compactDeployPlanFromPayloads(
  payloads: Record<string, unknown>[]
): Record<string, unknown> | null {
  const payload = payloads.find(
    (item) =>
      optionalStringField(item, "deployPlanStatus") ||
      optionalBooleanField(item, "canDeploy") !== null ||
      optionalBooleanField(item, "canRun") !== null ||
      optionalStringArrayField(item, "blockedReasons").length > 0 ||
      optionalStringArrayField(item, "staleReasons").length > 0
  );
  if (!payload) return null;

  const checks = isJsonRecord(payload.checks) ? payload.checks : null;
  const deployPlan: Record<string, unknown> = {};
  const status =
    optionalStringField(payload, "deployPlanStatus") ??
    optionalStringField(payload, "status");
  const canDeploy = optionalBooleanField(payload, "canDeploy");
  const canRun = optionalBooleanField(payload, "canRun");
  const blockedReasons = optionalStringArrayField(payload, "blockedReasons");
  const staleReasons = optionalStringArrayField(payload, "staleReasons");
  const artifactPaths = optionalStringArrayField(payload, "artifactPaths");

  if (status) deployPlan.status = status;
  if (canRun !== null) deployPlan.canRun = canRun;
  if (canDeploy !== null) deployPlan.canDeploy = canDeploy;
  for (const key of ["agentId", "projectId", "sourceRef", "baseSha"]) {
    const value = optionalStringField(payload, key);
    if (value) deployPlan[key] = value;
  }
  if (blockedReasons.length > 0) deployPlan.blockedReasons = blockedReasons;
  if (staleReasons.length > 0) deployPlan.staleReasons = staleReasons;
  if (artifactPaths.length > 0) deployPlan.artifactPaths = artifactPaths;
  if (checks) deployPlan.checks = checks;

  return Object.keys(deployPlan).length > 0 ? deployPlan : null;
}

function summarizeSourceCheckStatus(
  workItem: SandboxCodingWorkItem,
  activity: SandboxCodingWorkItemActivity[]
) {
  const payloads = activityPayloads(activity);
  const deployPlan =
    payloads
      .map((payload) => payload.deployPlan)
      .find(isJsonRecord) ?? compactDeployPlanFromPayloads(payloads);
  const requestedCheckKind =
    payloads
      .map(
        (payload) =>
          optionalStringField(payload, "checkKind") ??
          optionalStringField(payload, "requestedCheckKind")
      )
      .find(Boolean) ?? null;
  const traceArtifactRefs = uniqueStrings([
    optionalStringField(workItem, "traceArtifactRef"),
    ...payloads.map((payload) => optionalStringField(payload, "traceArtifactRef")),
    ...payloads.flatMap((payload) =>
      optionalStringArrayField(payload, "traceArtifactRefs")
    ),
  ]);
  const evalResultArtifactRefs = uniqueStrings([
    optionalStringField(workItem, "evalResultArtifactRef"),
    ...payloads.map((payload) =>
      optionalStringField(payload, "evalResultArtifactRef")
    ),
    ...payloads.flatMap((payload) =>
      optionalStringArrayField(payload, "evalResultArtifactRefs")
    ),
  ]);
  const publishBlockers = uniqueStrings([
    ...optionalStringArrayField(
      isJsonRecord(deployPlan) ? deployPlan : null,
      "blockedReasons"
    ),
    ...payloads.flatMap((payload) =>
      optionalStringArrayField(payload, "blockedReasons")
    ),
    ...payloads.flatMap((payload) =>
      optionalStringArrayField(payload, "publishBlockers")
    ),
  ]);
  const sourceMaterialization =
    payloads
      .map((payload) => optionalRecordField(payload, "sourceMaterialization"))
      .find(Boolean) ?? null;
  const setup =
    payloads.map((payload) => optionalRecordField(payload, "setup")).find(Boolean) ??
    null;
  const sourceUploadMetadata =
    payloads
      .map((payload) => optionalRecordField(payload, "sourceUploadMetadata"))
      .find(Boolean) ?? null;
  const policyDiscovery =
    payloads
      .map((payload) => optionalRecordField(payload, "policyDiscovery"))
      .find(Boolean) ?? null;
  const discoveredRequiredChecks = uniqueStrings([
    ...payloads.flatMap((payload) =>
      optionalStringArrayField(payload, "discoveredRequiredChecks")
    ),
    ...optionalStringArrayField(policyDiscovery, "requiredChecks"),
  ]);
  const checkRuns = payloads.flatMap((payload) =>
    optionalRecordArrayField(payload, "checkRuns")
  );
  const validation =
    payloads
      .map((payload) => optionalRecordField(payload, "validation"))
      .find(Boolean) ?? null;
  const evalSummary =
    payloads
      .map((payload) => optionalRecordField(payload, "eval"))
      .find(Boolean) ??
    payloads
      .map((payload) => optionalRecordField(payload, "evalSummary"))
      .find(Boolean) ??
    null;
  const validatorArtifactRefs = uniqueStrings(
    payloads.flatMap((payload) =>
      optionalStringArrayField(payload, "validatorArtifactRefs")
    )
  );
  const patchArtifactRef =
    payloads
      .map((payload) => optionalStringField(payload, "patchArtifactRef"))
      .find(Boolean) ?? null;
  const draftSourceRef =
    payloads
      .map((payload) => optionalStringField(payload, "draftSourceRef"))
      .find(Boolean) ?? null;
  const finalResultState =
    payloads
      .map((payload) => optionalStringField(payload, "finalResultState"))
      .find(Boolean) ?? null;
  return {
    workItemId: workItem.id,
    workItemStatus: optionalStringField(workItem, "status"),
    latestTaskRunId: optionalStringField(workItem, "latestTaskRunId"),
    latestRuntimeId: optionalStringField(workItem, "latestRuntimeId"),
    latestSandboxId: optionalStringField(workItem, "latestSandboxId"),
    sourceMaterialization,
    sourceUploadMetadata,
    setup,
    policyDiscovery,
    discoveredRequiredChecks,
    checkRuns,
    validation,
    eval: evalSummary,
    requestedCheckKind,
    deployPlan,
    traceArtifactRefs,
    evalResultArtifactRefs,
    validatorArtifactRefs,
    patchArtifactRef,
    draftSourceRef,
    finalResultState,
    publishBlockers,
  };
}

function unsafePublicOutputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("raw") ||
    normalized === "stdout" ||
    normalized === "stderr" ||
    normalized === "log" ||
    normalized === "logs" ||
    normalized === "events" ||
    normalized === "eventstream" ||
    normalized === "fulloutput" ||
    normalized === "processoutput" ||
    normalized === "tracejson" ||
    normalized === "evaljson" ||
    normalized === "evalresultsjson"
  );
}

function compactPublicValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 512
      ? `${value.slice(0, 512)}...[truncated:${value.length}]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => compactPublicValue(item));
  }
  if (isJsonRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (unsafePublicOutputKey(key)) continue;
      output[key] = compactPublicValue(item);
    }
    return output;
  }
  return value;
}

function compactRecordFields(
  record: Record<string, unknown> | null | undefined,
  fields: string[]
): Record<string, unknown> | null {
  if (!record) return null;
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in record)) continue;
    output[field] = compactPublicValue(record[field]);
  }
  return Object.keys(output).length > 0 ? output : null;
}

function compactWorkItem(
  workItem: SandboxCodingWorkItem
): Record<string, unknown> {
  return (
    compactRecordFields(workItem, [
      "id",
      "projectId",
      "assignedAgentId",
      "status",
      "sourceRef",
      "baseSha",
      "latestTaskRunId",
      "latestRuntimeId",
      "latestSandboxId",
      "traceArtifactRef",
      "evalResultArtifactRef",
      "createdAt",
      "updatedAt",
    ]) ?? { id: workItem.id }
  );
}

export function compactArtifact(
  artifact: Record<string, unknown>
): Record<string, unknown> {
  return (
    compactRecordFields(artifact, [
      "id",
      "kind",
      "ref",
      "taskRunId",
      "runtimeId",
      "sandboxId",
      "createdAt",
    ]) ?? {}
  );
}

function compactActivityPayload(
  payload: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  return compactRecordFields(payload, [
    "checkKind",
    "requestedCheckKind",
    "deployPlanStatus",
    "canDeploy",
    "canRun",
    "blockedReasons",
    "staleReasons",
    "artifactPaths",
    "agentId",
    "projectId",
    "sourceRef",
    "baseSha",
    "sourceMaterialization",
    "sourceUploadMetadata",
    "setup",
    "policyDiscovery",
    "discoveredRequiredChecks",
    "checkRuns",
    "validation",
    "eval",
    "evalSummary",
    "traceArtifactRef",
    "traceArtifactRefs",
    "evalResultArtifactRef",
    "evalResultArtifactRefs",
    "validatorArtifactRefs",
    "patchArtifactRef",
    "draftSourceRef",
    "finalResultState",
    "publishBlockers",
  ]);
}

export function compactWorkItemActivity(
  activity: SandboxCodingWorkItemActivity
): Record<string, unknown> {
  const output =
    compactRecordFields(activity, [
      "id",
      "type",
      "kind",
      "status",
      "summary",
      "message",
      "createdAt",
      "updatedAt",
    ]) ?? { id: activity.id };
  const payload = compactActivityPayload(
    optionalRecordField(activity, "payload")
  );
  if (payload) output.payload = payload;
  return output;
}

function compactSourceCheckStatus(
  status: Record<string, unknown>
): Record<string, unknown> {
  return (
    compactRecordFields(status, [
      "workItemId",
      "workItemStatus",
      "latestTaskRunId",
      "latestRuntimeId",
      "latestSandboxId",
      "sourceMaterialization",
      "sourceUploadMetadata",
      "setup",
      "policyDiscovery",
      "discoveredRequiredChecks",
      "checkRuns",
      "validation",
      "eval",
      "requestedCheckKind",
      "deployPlan",
      "traceArtifactRefs",
      "evalResultArtifactRefs",
      "validatorArtifactRefs",
      "patchArtifactRef",
      "draftSourceRef",
      "finalResultState",
      "publishBlockers",
    ]) ?? { workItemId: optionalStringField(status, "workItemId") ?? "unknown" }
  );
}

export function compactWorkItemStatusResult(status: {
  workItem: SandboxCodingWorkItem;
  activity: SandboxCodingWorkItemActivity[];
  sourceCheckStatus?: Record<string, unknown> | null;
}) {
  const sourceCheckStatus = isJsonRecord(status.sourceCheckStatus)
    ? status.sourceCheckStatus
    : summarizeSourceCheckStatus(status.workItem, status.activity);
  return {
    workItem: compactWorkItem(status.workItem),
    activity: status.activity.map((item) => compactWorkItemActivity(item)),
    sourceCheckStatus: compactSourceCheckStatus(sourceCheckStatus),
  };
}

export function compactBackgroundResult(
  result: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const workItem = optionalRecordField(result, "workItem");
  if (workItem) output.workItem = compactWorkItem(workItem as SandboxCodingWorkItem);
  const activity = optionalRecordField(result, "activity");
  if (activity) {
    output.activity = compactWorkItemActivity(
      activity as SandboxCodingWorkItemActivity
    );
  }
  for (const key of [
    "taskRun",
    "runtime",
    "session",
    "link",
    "toolSummary",
    "accepted",
    "status",
  ]) {
    if (key in result) output[key] = compactPublicValue(result[key]);
  }
  return output;
}

export function formatProjectLine(project: SandboxProject): string {
  const source = project.gitRepo
    ? `${project.gitOwner ?? "_"}/${project.gitRepo}`
    : project.internalRepoPath ??
      project.templateRepoUrl ??
      project.normalizedSourceIdentity;
  return [
    project.id,
    project.status,
    project.sourceType,
    project.name,
    source,
  ].join("  ");
}

export function formatAgentLine(agent: SandboxAgent): string {
  const entrypoint = agent.selectedEntrypoint.name
    ? `${agent.selectedEntrypoint.scope}:${agent.selectedEntrypoint.name}`
    : agent.selectedEntrypoint.scope;
  const agentSource = agent.runtimeSource
    ? [
        agent.runtimeSource.mode,
        agent.runtimeSource.publishedSnapshotName ??
          agent.runtimeSource.publishedSnapshotId ??
          agent.runtimeSource.sourceRef,
      ]
        .filter((value): value is string => Boolean(value))
        .join(":")
    : "latest_source";
  return [
    agent.id,
    agent.status,
    agent.triggerType,
    agent.defaultWorkflowMode,
    agentSource,
    entrypoint,
    agent.name,
  ].join("  ");
}
