import {
  SubagentWorkerBriefSchema,
  type AppPreferences,
  type RuntimeEvent,
  type Session,
  type SubagentDelegationMode,
  type SubagentProgress,
  type SubagentReviewRoutingPolicy,
  type SubagentReviewRoutingReason,
  type SubagentRoleSettings,
  type SubagentRun,
  type SubagentWorkerBrief,
} from "@openpond/contracts";
import {
  recordFromUnknown,
  stringFromRecord,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

export function subagentReviewable(run: SubagentRun): boolean {
  return (
    run.status === "submitted_for_review" ||
    run.status === "needs_revision" ||
    run.status === "needs_user_input" ||
    run.status === "failed_with_artifacts" ||
    run.review.status === "submitted_for_review" ||
    run.review.status === "needs_revision" ||
    run.review.status === "needs_user_input" ||
    run.review.status === "failed_with_artifacts"
  );
}

export function subagentDismissable(run: SubagentRun): boolean {
  return run.status === "blocked" ||
    run.status === "failed" ||
    run.status === "failed_with_artifacts" ||
    run.status === "cancelled";
}

export function subagentRunAccepted(run: SubagentRun): boolean {
  if (run.status === "superseded") return false;
  return run.status === "accepted" || run.status === "completed" || run.review.status === "accepted";
}

export function subagentRunDismissed(run: SubagentRun): boolean {
  return run.review.status === "dismissed";
}

export function subagentRunResolvedForGoal(run: SubagentRun): boolean {
  if (subagentRunAccepted(run) || subagentRunDismissed(run) || run.status === "superseded") return true;
  if (run.status === "cancelled") {
    const lifecycle = recordFromUnknown(run.metadata?.goalLifecycle);
    if (stringFromRecord(lifecycle ?? {}, "action") === "cancelled_by_parent_goal") return true;
  }
  if (run.required) return false;
  return run.status === "failed" || run.status === "failed_with_artifacts" || run.status === "cancelled";
}

export function assertSubagentRunAccessible(session: Session, run: SubagentRun): void {
  if (
    run.parentSessionId === session.id ||
    run.childSessionId === session.id ||
    (session.parentSessionId && session.parentSessionId === run.parentSessionId)
  ) {
    return;
  }
  throw new Error(`Subagent run ${run.id} is not linked to the current conversation.`);
}

export function subagentChildSystemContext(input: {
  role: SubagentRoleSettings;
  objective: string;
  parentSession: Session;
  contextPack: string | null;
  workerBrief: SubagentWorkerBrief;
}): string {
  return [
    `You are an OpenPond ${input.role.id} subagent running in an addressable child conversation.`,
    "Work only on the assignment below. Do not start additional subagents.",
    "The user may open this child conversation and talk to you directly.",
    `Tool policy: ${input.role.toolPolicy}. Isolation: ${input.role.isolationMode}.`,
    `Parent chat: ${input.parentSession.title} (${input.parentSession.id}).`,
    "Use openpond_subagent_send_message to message the parent when you have a blocker, decision request, important finding, or final handoff that should return control to the main agent. Omit target fields or use toRole: parent for parent handoffs.",
    "Use parent or sibling messages sparingly and deliberately; routine progress can stay in your child report unless it changes what the main agent should do now.",
    "",
    "Assignment:",
    input.objective,
    input.contextPack ? ["", "Context:", input.contextPack].join("\n") : "",
    "",
    formatSubagentWorkerBrief(input.workerBrief),
    "",
    "When you decide the assignment is done, stop working and submit a concise review packet.",
    "Your submission is not final acceptance; the parent or a reviewer will decide whether it is accepted, needs revision, or needs user input.",
    "The review packet must include summary, findings, files or artifacts changed/read, tests or checks run, blockers, confidence, and follow-up needed.",
  ].filter(Boolean).join("\n");
}

export function subagentChildPrompt(input: {
  objective: string;
  contextPack: string | null;
  workerBrief: SubagentWorkerBrief;
}): string {
  return [
    input.objective,
    input.contextPack ? ["Context:", input.contextPack].join("\n") : null,
    formatSubagentWorkerBrief(input.workerBrief),
  ].filter(Boolean).join("\n\n");
}

export function subagentWorkerBriefForStart(input: {
  role: SubagentRoleSettings;
  objective: string;
  provided: SubagentWorkerBrief | null;
}): SubagentWorkerBrief {
  const provided = SubagentWorkerBriefSchema.parse(input.provided ?? {});
  return SubagentWorkerBriefSchema.parse({
    plan: provided.plan.length > 0
      ? provided.plan
      : defaultSubagentBriefPlan(input.role.id),
    targetFiles: provided.targetFiles,
    acceptanceCriteria: provided.acceptanceCriteria.length > 0
      ? provided.acceptanceCriteria
      : defaultSubagentAcceptanceCriteria(input.objective),
    validationCommands: provided.validationCommands,
    stopConditions: provided.stopConditions.length > 0
      ? provided.stopConditions
      : defaultSubagentStopConditions(),
  });
}

function defaultSubagentBriefPlan(roleId: string): string[] {
  if (roleId === "coding") {
    return [
      "Orient on the relevant code and existing tests before editing.",
      "Make the smallest scoped implementation that satisfies the assignment.",
      "Run the focused validation commands from the brief, or explain why validation cannot run.",
      "Submit a review packet with changed files, validation evidence, blockers, and risks.",
    ];
  }
  if (roleId === "review") {
    return [
      "Inspect the supplied code, diff, report, or context.",
      "Identify correctness, regression, and test risks before style concerns.",
      "Submit ranked findings with concrete evidence and any required corrections.",
    ];
  }
  if (roleId === "test") {
    return [
      "Inspect the target behavior and existing coverage.",
      "Run or design focused validation for the assignment.",
      "Submit command evidence, failures, gaps, and recommended next checks.",
    ];
  }
  return [
    "Orient on the assignment and supplied context.",
    "Do the bounded specialist work for this role.",
    "Submit a review packet with findings, evidence, blockers, and risks.",
  ];
}

function defaultSubagentAcceptanceCriteria(objective: string): string[] {
  return [
    `Submit a reviewable result for: ${objective}`,
    "Attach or cite changed files, artifacts, references, or evidence when relevant.",
    "Report validation performed, or explain why validation is unavailable or not applicable.",
    "List unresolved blockers, risks, and follow-up needed.",
  ];
}

function defaultSubagentStopConditions(): string[] {
  return [
    "Stop and report a blocker if required context, permissions, dependencies, or workspace access are unavailable.",
    "Stop and submit for review instead of repeating the same search, read, or command pattern without new information.",
    "Stop and report recoverable artifacts if a provider, tool, or workspace failure occurs after meaningful work.",
  ];
}

function formatSubagentWorkerBrief(brief: SubagentWorkerBrief): string {
  return [
    "Structured worker brief:",
    formatSubagentBriefList("Plan", brief.plan),
    formatSubagentBriefList("Target files", brief.targetFiles),
    formatSubagentBriefList("Acceptance criteria", brief.acceptanceCriteria),
    formatSubagentBriefList("Validation commands", brief.validationCommands),
    formatSubagentBriefList("Stop conditions", brief.stopConditions),
  ].filter(Boolean).join("\n");
}

function formatSubagentBriefList(label: string, values: readonly string[]): string | null {
  if (values.length === 0) return null;
  return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

export type SubagentDelegationResolution = {
  mode: SubagentDelegationMode;
  source: "session_override" | "global_default";
};

export function resolveSubagentDelegation(
  session: Session,
  preferences: AppPreferences | null,
): SubagentDelegationResolution | null {
  if (session.subagentRunId || !preferences?.subagents.enabled) return null;
  return session.subagentDelegationMode
    ? { mode: session.subagentDelegationMode, source: "session_override" }
    : { mode: preferences.subagents.delegationMode, source: "global_default" };
}

function subagentDelegationInstruction(resolution: SubagentDelegationResolution): string {
  const behavior = resolution.mode === "manual"
    ? "Start subagents only when the user explicitly requests delegation."
    : resolution.mode === "proactive"
      ? "Prefer delegating meaningful independent research, coding, testing, and review work; use parallel children when workstreams are independent."
      : "Delegate clearly bounded work when parallelism or independent review is valuable; keep small linear work in the parent.";
  return [
    `Subagent delegation mode: ${resolution.mode}. ${behavior}`,
    "Keep planning, coordination, and final synthesis in the parent.",
    "Explicit user delegation instructions take priority over this default.",
  ].join("\n");
}

export function subagentSystemContextForSession(
  session: Session,
  delegation: SubagentDelegationResolution | null,
): string | null {
  if (!session.subagentRunId) {
    return delegation ? subagentDelegationInstruction(delegation) : null;
  }
  const subagent = recordFromUnknown(recordFromUnknown(session.metadata)?.subagent);
  const systemContext = typeof subagent?.systemContext === "string" ? subagent.systemContext.trim() : "";
  return systemContext || null;
}


export function subagentReviewPacketQuality(input: {
  run: SubagentRun;
  finalSummary: string | null;
  report: NonNullable<SubagentRun["report"]>;
  progress: SubagentProgress;
}): SubagentRun["review"]["packetQuality"] {
  const issues: string[] = [];
  const warnings: string[] = [];
  const finalSummary = input.finalSummary?.trim() ?? "";
  const requestedValidationCommandCount = input.run.workerBrief.validationCommands.length;
  const validationAttemptCount = input.progress.validationAttempts.length;
  const failedValidationCount = input.progress.validationAttempts.filter((attempt) => attempt.status === "failed").length;
  const testsRunCount = input.report.testsRun?.length ?? 0;
  const changedFileCount = input.progress.changedFiles.length;
  const patchRefPresent = Boolean(input.report.patchRef);
  const diffRefPresent = Boolean(input.report.diffRef);
  const artifactCount = input.report.artifacts?.length ?? 0;
  const findingCount = input.report.findings?.length ?? 0;
  const blockerCount = uniqueNonEmptyStrings([
    ...(input.report.blockers ?? []),
    input.progress.currentBlocker ?? "",
  ]).length;
  const validationAttempted = validationAttemptCount > 0 || testsRunCount > 0;
  const changed = changedFileCount > 0 || patchRefPresent || diffRefPresent;
  const unvalidatedWorkspaceChanges = changed && !validationAttempted;
  if (!finalSummary) {
    issues.push("Final report summary is missing.");
  }
  if (requestedValidationCommandCount > 0 && !validationAttempted) {
    warnings.push("Worker brief requested validation, but no validation attempt was observed.");
  }
  if (unvalidatedWorkspaceChanges) {
    warnings.push("Workspace changes have no observed validation attempt.");
  }
  return {
    status: issues.length > 0 ? "incomplete" : warnings.length > 0 ? "weak" : "reviewable",
    issues,
    warnings,
    evidence: {
      finalSummaryPresent: finalSummary.length > 0,
      finalSummaryLength: finalSummary.length,
      requestedValidationCommandCount,
      validationAttemptCount,
      failedValidationCount,
      testsRunCount,
      changedFileCount,
      patchRefPresent,
      diffRefPresent,
      artifactCount,
      findingCount,
      blockerCount,
      unvalidatedWorkspaceChanges,
    },
  };
}

export function subagentReviewRoutingRecommendation(input: {
  run: SubagentRun;
  reviewRoutingPolicy: SubagentReviewRoutingPolicy;
  packetQuality: SubagentRun["review"]["packetQuality"];
  report: NonNullable<SubagentRun["report"]>;
  progress: SubagentProgress;
  providerFailureAfterChanges?: boolean;
}): Pick<
  SubagentRun["review"],
  "independentReviewRecommended" | "reviewerRoutingReasons" | "reviewerRoutingEvidence"
> {
  const changedFiles = uniqueNonEmptyStrings([
    ...(input.progress.changedFiles ?? []),
    ...(input.report.patchRef ? [input.report.patchRef.label, input.report.patchRef.id] : []),
    ...(input.report.diffRef ? [input.report.diffRef.label, input.report.diffRef.id] : []),
  ]);
  const validationAttemptCount = input.progress.validationAttempts.length + (input.report.testsRun?.length ?? 0);
  const failedValidationCount = input.progress.validationAttempts.filter((attempt) => attempt.status === "failed").length;
  const highRiskFileCount = changedFiles.filter((filePath) =>
    subagentReviewHighRiskPath(filePath, input.reviewRoutingPolicy.highRiskPathPatterns)
  ).length;
  const missingRequestedValidation =
    input.run.workerBrief.validationCommands.length > 0 && validationAttemptCount === 0;
  const changedWithoutValidation = changedFiles.length > 0 && validationAttemptCount === 0;
  const providerFailureAfterChanges = Boolean(input.providerFailureAfterChanges);
  const userRequestedIndependentReview = subagentUserRequestedIndependentReview(input.run);
  const reasons = uniqueSubagentReviewRoutingReasons([
    input.packetQuality.status === "incomplete" ? "packet_quality_incomplete" : "",
    input.packetQuality.status === "weak" ? "packet_quality_weak" : "",
    input.report.confidence === "low" ? "low_confidence" : "",
    failedValidationCount > 0 ? "validation_failed" : "",
    missingRequestedValidation || changedWithoutValidation ? "validation_missing" : "",
    changedFiles.length >= input.reviewRoutingPolicy.broadEditSurfaceFileThreshold ? "broad_edit_surface" : "",
    highRiskFileCount > 0 ? "high_risk_files" : "",
    providerFailureAfterChanges ? "provider_failure_after_changes" : "",
    userRequestedIndependentReview ? "user_requested_independent_review" : "",
  ]);
  return {
    independentReviewRecommended: reasons.length > 0,
    reviewerRoutingReasons: reasons,
    reviewerRoutingEvidence: {
      packetQualityStatus: input.packetQuality.status,
      confidence: input.report.confidence ?? null,
      changedFileCount: changedFiles.length,
      highRiskFileCount,
      validationAttemptCount,
      failedValidationCount,
      missingRequestedValidation,
      providerFailureAfterChanges,
      userRequestedIndependentReview,
    },
  };
}

function uniqueSubagentReviewRoutingReasons(
  reasons: Array<SubagentReviewRoutingReason | "" | null | undefined>,
): SubagentReviewRoutingReason[] {
  const seen = new Set<SubagentReviewRoutingReason>();
  const result: SubagentReviewRoutingReason[] = [];
  for (const reason of reasons) {
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    result.push(reason);
  }
  return result;
}

function subagentReviewHighRiskPath(value: string, patterns: readonly string[]): boolean {
  const normalized = value.trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(normalized);
    } catch {
      return false;
    }
  });
}

function subagentUserRequestedIndependentReview(run: SubagentRun): boolean {
  const text = [
    run.objective,
    ...run.workerBrief.plan,
    ...run.workerBrief.acceptanceCriteria,
    ...run.workerBrief.stopConditions,
  ].join("\n").toLowerCase();
  return /\b(independent review|independent reviewer|separate review|separate reviewer|second reviewer|second pass review)\b/.test(text);
}

export function activeThreadGoalId(events: RuntimeEvent[], sessionId: string): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (item.sessionId !== sessionId || item.name !== "diagnostic") continue;
    const data = item.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    if (record.kind === "thread_goal_cleared") return null;
    if (record.kind !== "thread_goal") continue;
    const goal = record.goal;
    if (!goal || typeof goal !== "object" || Array.isArray(goal)) continue;
    const goalRecord = goal as Record<string, unknown>;
    const status = stringFromRecord(goalRecord, "status")?.toLowerCase() ?? "active";
    if (status === "completed" || status === "complete" || status === "failed" || status === "stopped") {
      return null;
    }
    return stringFromRecord(goalRecord, "id");
  }
  return null;
}

