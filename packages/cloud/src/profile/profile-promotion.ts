import type {
  LocalOpenPondProfileHostedPublishStatus,
  LocalOpenPondProfileHostedRunSummary,
  LocalOpenPondProfileHostedSourceCheckStatus,
} from "../config.js";

export function hostedSourceCheckStatusFromPayload(input: {
  agentId: string;
  status: string;
  deployPlan?: unknown;
  checkResult?: unknown;
  checkedAt?: string;
  error?: string | null;
}): LocalOpenPondProfileHostedSourceCheckStatus {
  const checkResult = record(input.checkResult);
  const deployPlan = record(checkResult?.deployPlan) ?? record(input.deployPlan);
  const source = record(deployPlan?.source);
  const checks = record(deployPlan?.checks);
  const workItem = record(checkResult?.workItem);
  const sourceCheckStatus = record(checkResult?.sourceCheckStatus);
  return {
    status: input.status,
    agentId: input.agentId,
    workItemId: text(workItem?.id),
    deployPlanStatus: text(deployPlan?.status),
    canRun: booleanValue(deployPlan?.canRun),
    canDeploy: booleanValue(deployPlan?.canDeploy),
    sourceRef: text(source?.sourceRef),
    sourceCommitSha: text(source?.sourceCommitSha),
    manifestHash: text(source?.manifestHash),
    manifestPath: text(source?.manifestPath),
    setupCommands: textArray(checks?.setupCommands),
    validationCommands: textArray(checks?.validationCommands),
    requiredChecks: textArray(checks?.requiredChecks),
    evalNames: textArray(checks?.evalNames),
    blockedReasons: textArray(deployPlan?.blockedReasons),
    staleReasons: textArray(deployPlan?.staleReasons),
    runtimeId: text(sourceCheckStatus?.latestRuntimeId),
    sandboxId: text(sourceCheckStatus?.latestSandboxId),
    traceArtifactRefs: textArray(sourceCheckStatus?.traceArtifactRefs),
    evalResultArtifactRefs: textArray(sourceCheckStatus?.evalResultArtifactRefs),
    validatorArtifactRefs: textArray(sourceCheckStatus?.validatorArtifactRefs),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    error: input.error ?? null,
  };
}

export function hostedPublishStatusFromPayload(input: {
  agentId: string;
  publishResult: unknown;
  status?: string;
  error?: string | null;
}): LocalOpenPondProfileHostedPublishStatus {
  const result = record(input.publishResult);
  const snapshot =
    record(result?.activeManifestSnapshot) ??
    record(result?.manifestSnapshot) ??
    record(result?.snapshot);
  return {
    status: input.status ?? "published",
    agentId: input.agentId,
    snapshotId: text(snapshot?.id),
    sourceRef: text(snapshot?.sourceRef),
    sourceCommitSha: text(snapshot?.sourceCommitSha),
    manifestHash: text(snapshot?.manifestHash),
    manifestPath: text(snapshot?.manifestPath),
    buildStatus: text(snapshot?.buildStatus),
    validationStatus: text(snapshot?.validationStatus),
    evalStatus: text(snapshot?.evalStatus),
    publishedAt: text(result?.publishedAt) ?? text(snapshot?.publishedAt),
    error: input.error ?? null,
  };
}

export function hostedRunSummaryFromPayload(input: {
  agentId: string;
  runResult: unknown;
  error?: string | null;
}): LocalOpenPondProfileHostedRunSummary {
  const result = record(input.runResult);
  const run = record(result?.run);
  const runtimeSource = record(run?.runtimeSource);
  const metadata = record(run?.metadata);
  const sourceSummary = record(metadata?.sourceSummary);
  const setupGate = record(metadata?.setupGate);
  const responseSummary = record(metadata?.responseSummary);
  const traceSummary = record(metadata?.traceSummary);
  const evalSummary = record(metadata?.evalSummary);
  return {
    status: text(run?.status) ?? (input.error ? "failed" : "running"),
    agentId: text(run?.agentId) ?? input.agentId,
    runId: text(run?.id),
    runtimeId: text(run?.runtimeId),
    sandboxId: text(run?.sandboxId),
    sourceRef: text(runtimeSource?.sourceRef) ?? text(sourceSummary?.sourceRef) ?? text(metadata?.sourceRef),
    sourceCommitSha:
      text(runtimeSource?.sourceCommitSha) ??
      text(sourceSummary?.sourceCommitSha) ??
      text(metadata?.hostedHead),
    manifestHash: text(runtimeSource?.manifestHash) ?? text(sourceSummary?.manifestHash),
    setupGateStatus: text(setupGate?.status),
    setupRequirementRefs: setupRequirementRefs(setupGate),
    artifactRefs: textArray(responseSummary?.artifactRefs),
    traceArtifactRefs: textArray(traceSummary?.artifactRefs),
    evalArtifactRefs: textArray(evalSummary?.artifactRefs),
    startedAt: text(run?.createdAt),
    completedAt: text(run?.completedAt),
    error: input.error ?? null,
  };
}

export function hostedRunStatusFromRunSummary(
  summary: LocalOpenPondProfileHostedRunSummary | null | undefined
): "not_started" | "running" | "passed" | "failed" {
  if (!summary?.status) return "not_started";
  if (summary.status === "succeeded" || summary.status === "passed") return "passed";
  if (summary.status === "failed" || summary.status === "cancelled") return "failed";
  return "running";
}

function setupRequirementRefs(setupGate: Record<string, unknown> | null): string[] {
  if (!setupGate) return [];
  const requirements = Array.isArray(setupGate.requirements)
    ? setupGate.requirements
    : Array.isArray(setupGate.blockingRequirements)
      ? setupGate.blockingRequirements
      : [];
  return requirements
    .map((item) => {
      const requirement = record(item);
      return text(requirement?.ref) ?? text(requirement?.id) ?? text(requirement?.label);
    })
    .filter((item): item is string => Boolean(item));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
