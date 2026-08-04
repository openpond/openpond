import {
  FileOutputRefSchema,
  type FileOutputRef,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import {
  canonicalJson,
  contentHash,
  type ImmutableReleaseRef,
} from "@openpond/evals";
import {
  createWorkEvidenceReceipt,
  createWorkProcessTrace,
  evidenceArtifactRef,
  workSourceOpaqueRef,
  workWorkspaceOpaqueRef,
  type EvidenceArtifactRef,
  type WorkEvidenceReceipt,
  type WorkProcessStep,
  type WorkProcessTrace,
} from "@openpond/evals/evidence";
import { z } from "zod";

export const DESKTOP_WORK_EVIDENCE_PROJECTOR_VERSION =
  "openpond.desktop-work-evidence-projector.v1" as const;
export const DESKTOP_WORK_SANITATION_POLICY_VERSION =
  "openpond.desktop-work-sanitizer.v1" as const;

export const DesktopWorkEvidenceConsentSchema = z.object({
  schemaVersion: z.literal("openpond.desktopWorkEvidenceConsent.v1"),
  status: z.literal("granted"),
  scope: z.literal("work_process_and_artifacts"),
  grantedAt: z.string().datetime({ offset: true }),
  policyVersion: z.string().trim().min(1).max(200),
  ownershipScope: z.enum(["personal", "workspace"]),
  workspaceId: z.string().trim().min(1).max(1_000).nullable(),
  participantPolicy: z.enum(["creator_only", "all_participants"]),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type DesktopWorkEvidenceConsent = z.infer<typeof DesktopWorkEvidenceConsentSchema>;

export type DesktopWorkEvidenceProjection = {
  sourceRevisionHash: string;
  privateTrace: Record<string, unknown>;
  sanitizedTrace: WorkProcessTrace;
  receipt: WorkEvidenceReceipt;
  consentArtifact: { value: Record<string, unknown>; ref: EvidenceArtifactRef };
  outputArtifacts: Array<{
    output: FileOutputRef;
    contentRef: EvidenceArtifactRef;
    revisionDescriptor: Record<string, unknown>;
    revisionRef: EvidenceArtifactRef;
  }>;
  validationArtifacts: Array<{ value: Record<string, unknown>; ref: EvidenceArtifactRef }>;
};

export function projectDesktopWorkEvidence(input: {
  session: Session;
  turn: Turn;
  runtimeEvents: RuntimeEvent[];
  usageRecords: ModelUsageRecord[];
  consent: DesktopWorkEvidenceConsent;
  agentSnapshot?: ImmutableReleaseRef | null;
  projectedAt?: string;
}): DesktopWorkEvidenceProjection {
  assertProjectable(input);
  const events = normalizedTurnEvents(input.runtimeEvents, input.turn.id);
  const outputs = fileOutputs(events);
  const sourceRevisionHash = contentHash({
    sessionExecutionBinding: {
      idHash: contentHash(input.session.id),
      experience: input.session.experience,
      provider: input.session.provider,
      modelRef: input.session.modelRef,
      workspaceKind: input.session.workspaceKind,
      workspaceIdHash: input.session.workspaceId ? contentHash(input.session.workspaceId) : null,
    },
    turn: input.turn,
    events,
    usageRecords: input.usageRecords,
    outputs,
  });
  const validationArtifacts = outputs.flatMap((output) => {
    if (!output.validation.length) return [];
    const value = {
      schemaVersion: "openpond.workValidationEvidence.v1",
      outputContentHash: output.sha256,
      outputRevision: output.revision,
      evidence: output.validation.map((item) => ({
        kind: item.kind,
        status: item.status,
        labelHash: contentHash(item.label),
        detailHash: item.detail ? contentHash(item.detail) : null,
        refHash: item.ref ? contentHash(item.ref) : null,
      })),
    };
    return [{ value, ref: jsonRef(value, "application/vnd.openpond.work-validation+json") }];
  });
  const validationRefsByOutput = new Map(
    validationArtifacts.map((artifact) => [
      `${artifact.value.outputContentHash}:${artifact.value.outputRevision}`,
      artifact.ref,
    ]),
  );
  const outputArtifacts = outputs.map((output) => {
    const contentRef = evidenceArtifactRef({
      contentHash: output.sha256,
      mediaType: output.contentType,
      sizeBytes: output.sizeBytes,
    });
    const validationRef = validationRefsByOutput.get(`${output.sha256}:${output.revision}`) ?? null;
    const revisionDescriptor = {
      schemaVersion: "openpond.workOutputRevisionEvidence.v1",
      contentRef,
      revision: output.revision,
      createdAt: output.createdAt,
      validationEvidenceRefs: validationRef ? [validationRef] : [],
    };
    return {
      output,
      contentRef,
      revisionDescriptor,
      revisionRef: jsonRef(
        revisionDescriptor,
        "application/vnd.openpond.work-output-revision+json",
      ),
    };
  });
  const traceProjection = sanitizeProcessTrace({
    events,
    turn: input.turn,
    sourceRevisionHash,
    outputArtifacts,
  });
  const sanitizedTrace = createWorkProcessTrace({
    schemaVersion: "openpond.workProcessTrace.v1",
    sourceRevisionHash,
    sanitationPolicyVersion: DESKTOP_WORK_SANITATION_POLICY_VERSION,
    incomplete: traceProjection.incompleteReasons.length > 0,
    incompleteReasons: traceProjection.incompleteReasons,
    droppedEventCount: traceProjection.droppedEventCount,
    steps: traceProjection.steps,
  });
  const traceRef = evidenceArtifactRef({
    contentHash: sanitizedTrace.contentHash,
    mediaType: "application/vnd.openpond.work-process-trace+json",
    sizeBytes: byteLength(sanitizedTrace),
  });
  const workspaceRef = input.consent.workspaceId
    ? workWorkspaceOpaqueRef(input.consent.workspaceId)
    : null;
  const consentValue = {
    schemaVersion: "openpond.workEvidenceConsentReceipt.v1",
    scope: input.consent.scope,
    grantedAt: input.consent.grantedAt,
    policyVersion: input.consent.policyVersion,
    ownershipScope: input.consent.ownershipScope,
    workspaceRef,
    participantPolicy: input.consent.participantPolicy,
    expiresAt: input.consent.expiresAt,
  };
  const consentArtifact = {
    value: consentValue,
    ref: jsonRef(consentValue, "application/vnd.openpond.work-evidence-consent+json"),
  };
  const timing = receiptTiming(input.turn);
  const usage = usageSummary(input.usageRecords);
  const terminal = receiptTerminal(input.turn);
  const receipt = createWorkEvidenceReceipt({
    schemaVersion: "openpond.workEvidenceReceipt.v1",
    id: `work-evidence-${contentHash([sourceRevisionHash, sanitizedTrace.contentHash]).slice(0, 24)}`,
    source: {
      surface: "desktop",
      experience: input.session.experience === "development" ? "development" : "work",
      opaqueRef: workSourceOpaqueRef([input.session.id, input.turn.id]),
      revisionHash: sourceRevisionHash,
    },
    agentSnapshot: input.agentSnapshot ?? null,
    model: modelRef(input.session, input.turn, input.usageRecords),
    runtime: {
      adapterId: "desktop-work",
      adapterVersion: DESKTOP_WORK_EVIDENCE_PROJECTOR_VERSION,
      capabilityRef: null,
    },
    inputHash: contentHash(input.turn.prompt),
    terminal,
    trace: {
      sanitizedRef: traceRef,
      traceHash: sanitizedTrace.contentHash,
      sanitationPolicyVersion: DESKTOP_WORK_SANITATION_POLICY_VERSION,
      incomplete: sanitizedTrace.incomplete,
    },
    outputRefs: outputArtifacts.map((artifact) => artifact.revisionRef),
    artifactRefs: uniqueArtifacts(outputArtifacts.map((artifact) => artifact.contentRef)),
    validationEvidenceRefs: uniqueArtifacts(validationArtifacts.map((artifact) => artifact.ref)),
    interventions: interventionCounts(events),
    timing,
    usage,
    costUsd: null,
    provenance: {
      consentReceiptRef: consentArtifact.ref,
      consentScope: input.consent.scope,
      consentGrantedAt: input.consent.grantedAt,
      policyVersion: input.consent.policyVersion,
      projectorVersion: DESKTOP_WORK_EVIDENCE_PROJECTOR_VERSION,
      disclosure: "portable_sanitized",
      ownershipScope: input.consent.ownershipScope,
      workspaceRef,
      participantPolicy: input.consent.participantPolicy,
      retention: {
        policy: "source_bound",
        deleteWithSource: true,
        expiresAt: input.consent.expiresAt,
      },
    },
  });
  return {
    sourceRevisionHash,
    privateTrace: {
      schemaVersion: "openpond.desktopPrivateWorkTrace.v1",
      session: input.session,
      turn: input.turn,
      runtimeEvents: events,
      usageRecords: input.usageRecords,
      outputs,
      sourceRevisionHash,
    },
    sanitizedTrace,
    receipt,
    consentArtifact,
    outputArtifacts,
    validationArtifacts,
  };
}

function assertProjectable(input: {
  session: Session;
  turn: Turn;
  consent: DesktopWorkEvidenceConsent;
  projectedAt?: string;
}): void {
  if (input.session.experience !== "work" && input.session.experience !== "development") {
    throw new Error("Only Work and Development turns can produce Work evidence.");
  }
  if (input.turn.sessionId !== input.session.id) {
    throw new Error("The Work turn belongs to a different session.");
  }
  if (input.turn.status === "in_progress" || !input.turn.completedAt) {
    throw new Error("Work evidence requires an authoritative terminal turn.");
  }
  if (input.consent.status !== "granted" || input.consent.scope !== "work_process_and_artifacts") {
    throw new Error("Explicit process-and-artifact evidence consent is required.");
  }
  if (input.consent.ownershipScope === "workspace" && !input.consent.workspaceId) {
    throw new Error("Workspace evidence consent requires a workspace id.");
  }
  if (input.consent.ownershipScope === "personal" && input.consent.workspaceId) {
    throw new Error("Personal evidence consent cannot bind a workspace id.");
  }
  const projectedAt = input.projectedAt ?? input.turn.completedAt;
  if (
    input.consent.expiresAt
    && projectedAt
    && Date.parse(input.consent.expiresAt) <= Date.parse(projectedAt)
  ) {
    throw new Error("Work evidence consent expired before projection.");
  }
  const participants = input.session.metadata?.participantCount;
  if (
    typeof participants === "number"
    && participants > 1
    && input.consent.participantPolicy !== "all_participants"
  ) {
    throw new Error("Multi-participant Work requires all-participant evidence consent.");
  }
}

function normalizedTurnEvents(events: RuntimeEvent[], turnId: string): RuntimeEvent[] {
  const unique = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    const existing = unique.get(event.id);
    if (!existing || eventSortKey(event) < eventSortKey(existing)) unique.set(event.id, event);
  }
  return [...unique.values()].sort((left, right) => eventSortKey(left).localeCompare(eventSortKey(right)));
}

function eventSortKey(event: RuntimeEvent): string {
  return `${String(event.sequence ?? Number.MAX_SAFE_INTEGER).padStart(16, "0")}:${event.timestamp}:${event.id}`;
}

function fileOutputs(events: RuntimeEvent[]): FileOutputRef[] {
  const byRevision = new Map<string, FileOutputRef>();
  for (const event of events) {
    for (const output of findFileOutputs(event.data)) {
      byRevision.set(`${output.id}:${output.revision}`, output);
    }
  }
  return [...byRevision.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id) || left.revision - right.revision,
  );
}

function findFileOutputs(value: unknown, depth = 0): FileOutputRef[] {
  if (value == null || depth > 8) return [];
  const parsed = FileOutputRefSchema.safeParse(value);
  if (parsed.success) return [parsed.data];
  if (Array.isArray(value)) return value.flatMap((item) => findFileOutputs(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>)
    .flatMap((item) => findFileOutputs(item, depth + 1));
}

function sanitizeProcessTrace(input: {
  events: RuntimeEvent[];
  turn: Turn;
  sourceRevisionHash: string;
  outputArtifacts: DesktopWorkEvidenceProjection["outputArtifacts"];
}): {
  steps: WorkProcessStep[];
  incompleteReasons: Array<"missing_start" | "missing_terminal" | "unsupported_events_dropped" | "uncorrelated_environment_step" | "artifact_unavailable">;
  droppedEventCount: number;
} {
  const steps: WorkProcessStep[] = [];
  let droppedEventCount = 0;
  let uncorrelatedEnvironmentSteps = 0;
  const turnReceiptHash = contentHash(["agent-turn", input.sourceRevisionHash]);
  let activeAgentReceiptHash: string | null = turnReceiptHash;
  const push = (step: Omit<WorkProcessStep, "sequence">) => steps.push({ ...step, sequence: steps.length });
  for (const event of input.events) {
    const callReceiptHash = agentCallReceiptHash(event);
    if (event.name === "tool.started" && callReceiptHash) activeAgentReceiptHash = callReceiptHash;
    const mapped = eventSteps(
      event,
      input.outputArtifacts,
      callReceiptHash ?? activeAgentReceiptHash,
      turnReceiptHash,
    );
    if (mapped === null) {
      if (!IGNORED_EVENT_NAMES.has(event.name)) {
        droppedEventCount += 1;
        if (isEnvironmentEvent(event)) uncorrelatedEnvironmentSteps += 1;
      }
      continue;
    }
    for (const step of mapped) push(step);
    if (event.name === "tool.completed" && callReceiptHash) activeAgentReceiptHash = callReceiptHash;
  }
  const hasStart = input.events.some((event) => event.name === "turn.started");
  const hasTerminal = input.events.some((event) =>
    event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted",
  );
  const incompleteReasons: Array<"missing_start" | "missing_terminal" | "unsupported_events_dropped" | "uncorrelated_environment_step" | "artifact_unavailable"> = [];
  if (!hasStart) incompleteReasons.push("missing_start");
  if (!hasTerminal) incompleteReasons.push("missing_terminal");
  if (droppedEventCount > 0) incompleteReasons.push("unsupported_events_dropped");
  if (uncorrelatedEnvironmentSteps > 0) incompleteReasons.push("uncorrelated_environment_step");
  if (fileOutputs(input.events).some((output) => output.location.kind !== "local")) {
    incompleteReasons.push("artifact_unavailable");
  }
  if (!hasTerminal) {
    const terminal = receiptTerminal(input.turn);
    push(baseStep({
      timestamp: input.turn.completedAt!,
      layer: "agent",
      kind: "state_transition",
      action: terminal.status === "completed"
        ? "turn_completed"
        : terminal.status === "cancelled"
        ? "turn_cancelled"
        : terminal.status === "timeout"
        ? "turn_timed_out"
        : "turn_failed",
      status: terminal.status === "completed" ? "completed" : terminal.status === "cancelled" ? "cancelled" : "failed",
      transitionState: terminal.status,
      receiptHash: turnReceiptHash,
      errorClass: terminal.failureClass ? processErrorClass(terminal.failureClass) : null,
    }));
  }
  return { steps, incompleteReasons: unique(incompleteReasons), droppedEventCount };
}

const IGNORED_EVENT_NAMES = new Set<RuntimeEvent["name"]>([
  "assistant.delta",
  "assistant.reasoning.delta",
  "session.context.updated",
  "session.compaction.started",
  "session.compaction.completed",
  "session.compaction.failed",
  "skill.selected",
  "skill.loaded",
  "skill.load_failed",
  "diagnostic",
]);

function eventSteps(
  event: RuntimeEvent,
  outputs: DesktopWorkEvidenceProjection["outputArtifacts"],
  parentAgentReceiptHash: string | null,
  turnReceiptHash: string,
): Array<Omit<WorkProcessStep, "sequence">> | null {
  if (event.name === "turn.started") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "state_transition", action: "turn_started", status: "started", transitionState: "running", receiptHash: turnReceiptHash })];
  }
  if (event.name === "turn.completed") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "state_transition", action: "turn_completed", status: "completed", transitionState: "completed", receiptHash: turnReceiptHash })];
  }
  if (event.name === "turn.failed") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "state_transition", action: "turn_failed", status: "failed", transitionState: "failed", receiptHash: turnReceiptHash, errorClass: "unknown" })];
  }
  if (event.name === "turn.interrupted") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "state_transition", action: "turn_cancelled", status: "cancelled", transitionState: "cancelled", receiptHash: turnReceiptHash, errorClass: "cancelled" })];
  }
  if (event.name === "tool.started") {
    return [baseStep({
      timestamp: event.timestamp,
      layer: "agent",
      kind: "tool",
      action: "tool_invoked",
      status: "started",
      inputHash: hashPresent(event.args),
      receiptHash: agentCallReceiptHash(event),
      toolCategory: toolCategory(event),
    })];
  }
  if (event.name === "tool.completed") {
    const failed = event.status === "failed" || Boolean(event.error);
    const artifactRefs = eventOutputArtifactRefs(event, outputs);
    const validationRefs = eventValidationArtifactRefs(event, outputs);
    const toolStep = baseStep({
      timestamp: event.timestamp,
      layer: "agent",
      kind: "tool",
      action: failed ? "tool_failed" : "tool_completed",
      status: failed ? "failed" : "completed",
      outputHash: hashPresent(event.output ?? event.data),
      receiptHash: agentCallReceiptHash(event) ?? parentAgentReceiptHash,
      toolCategory: toolCategory(event),
      errorClass: failed ? "unknown" : null,
      artifacts: artifactRefs,
    });
    const artifactSteps = artifactRefs.map((artifact) => baseStep({
      timestamp: event.timestamp,
      layer: "environment" as const,
      kind: "artifact" as const,
      action: "artifact_created" as const,
      status: "completed" as const,
      outputHash: artifact.contentHash,
      receiptHash: environmentReceiptHash(event),
      parentReceiptHash: agentCallReceiptHash(event) ?? parentAgentReceiptHash,
      artifacts: [artifact],
    }));
    const validationSteps = validationRefs.map((validation) => baseStep({
      timestamp: event.timestamp,
      layer: "environment" as const,
      kind: "validation" as const,
      action: "validation_completed" as const,
      status: "completed" as const,
      outputHash: validation.contentHash,
      receiptHash: contentHash(["environment-validation", validation.contentHash]),
      parentReceiptHash: agentCallReceiptHash(event) ?? parentAgentReceiptHash,
      validationKind: "other" as const,
      artifacts: [validation],
    }));
    return [toolStep, ...artifactSteps, ...validationSteps];
  }
  if (event.name === "workspace_action" || event.name === "workspace_action_result" || event.name === "command.output") {
    if (!parentAgentReceiptHash) return null;
    const failed = event.status === "failed" || Boolean(event.error);
    const action = environmentLifecycleAction(event);
    if (action) {
      return [baseStep({
        timestamp: event.timestamp,
        layer: "environment",
        kind: action === "cleanup_completed" || action === "cleanup_failed" ? "cleanup" : "state_transition",
        action,
        status: failed ? "failed" : event.status === "started" || event.status === "pending" ? "started" : "completed",
        outputHash: hashPresent(event.output ?? event.data),
        receiptHash: environmentReceiptHash(event),
        parentReceiptHash: parentAgentReceiptHash,
        transitionState: action === "environment_created" || action === "environment_reset"
          ? "running"
          : action === "environment_destroyed" || action === "cleanup_completed"
          ? "completed"
          : failed ? "failed" : null,
        errorClass: failed ? "environment" : null,
        durationMs: environmentDurationMs(event),
        cpuTimeMs: environmentCpuTimeMs(event),
        memoryPeakBytes: environmentMemoryPeakBytes(event),
      })];
    }
    const artifactRefs = eventOutputArtifactRefs(event, outputs);
    return [baseStep({
      timestamp: event.timestamp,
      layer: "environment",
      kind: "tool",
      action: failed ? "tool_failed" : event.status === "started" || event.status === "pending" ? "tool_invoked" : "tool_completed",
      status: failed ? "failed" : event.status === "started" || event.status === "pending" ? "started" : "completed",
      inputHash: hashPresent(event.args),
      outputHash: hashPresent(event.output ?? event.data),
      receiptHash: environmentReceiptHash(event),
      parentReceiptHash: parentAgentReceiptHash,
      toolCategory: toolCategory(event),
      errorClass: failed ? "environment" : null,
      artifacts: artifactRefs,
      exitCode: environmentExitCode(event),
      durationMs: environmentDurationMs(event),
      cpuTimeMs: environmentCpuTimeMs(event),
      memoryPeakBytes: environmentMemoryPeakBytes(event),
    })];
  }
  if (event.name === "workspace.diff") {
    if (!parentAgentReceiptHash) return null;
    return [baseStep({
      timestamp: event.timestamp,
      layer: "environment",
      kind: "artifact",
      action: "workspace_changed",
      status: event.status === "failed" ? "failed" : "completed",
      outputHash: hashPresent(event.output ?? event.data),
      receiptHash: environmentReceiptHash(event),
      parentReceiptHash: parentAgentReceiptHash,
      errorClass: event.status === "failed" ? "unknown" : null,
    })];
  }
  if (event.name === "approval.requested") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "approval", action: "approval_requested", status: "started", interventionOutcome: "requested" })];
  }
  if (event.name === "approval.resolved") {
    const denied = event.status === "failed";
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "approval", action: "approval_resolved", status: denied ? "failed" : "completed", interventionOutcome: denied ? "denied" : "approved" })];
  }
  if (event.name === "user_question.asked") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "question", action: "question_asked", status: "started", interventionOutcome: "requested" })];
  }
  if (event.name === "user_question.answered") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "question", action: "question_answered", status: "completed", interventionOutcome: "answered" })];
  }
  if (event.name === "user_question.dismissed") {
    return [baseStep({ timestamp: event.timestamp, layer: "agent", kind: "question", action: "question_dismissed", status: "cancelled", interventionOutcome: "dismissed" })];
  }
  return null;
}

function baseStep(input: {
  timestamp: string;
  layer: WorkProcessStep["layer"];
  kind: WorkProcessStep["kind"];
  action: WorkProcessStep["action"];
  status: WorkProcessStep["status"];
  inputHash?: string | null;
  outputHash?: string | null;
  receiptHash?: string | null;
  parentReceiptHash?: string | null;
  artifacts?: EvidenceArtifactRef[];
  toolCategory?: WorkProcessStep["attributes"]["toolCategory"];
  validationKind?: WorkProcessStep["attributes"]["validationKind"];
  transitionState?: WorkProcessStep["attributes"]["transitionState"];
  interventionOutcome?: WorkProcessStep["attributes"]["interventionOutcome"];
  exitCode?: number | null;
  durationMs?: number | null;
  cpuTimeMs?: number | null;
  memoryPeakBytes?: number | null;
  errorClass?: WorkProcessStep["attributes"]["errorClass"];
}): Omit<WorkProcessStep, "sequence"> {
  const artifacts = input.artifacts ?? [];
  return {
    timestamp: input.timestamp,
    layer: input.layer,
    kind: input.kind,
    action: input.action,
    status: input.status,
    inputHash: input.inputHash ?? null,
    outputHash: input.outputHash ?? null,
    receiptHash: input.receiptHash ?? null,
    parentReceiptHash: input.parentReceiptHash ?? null,
    artifactRefs: artifacts,
    attributes: {
      toolCategory: input.toolCategory ?? null,
      validationKind: input.validationKind ?? null,
      transitionState: input.transitionState ?? null,
      interventionOutcome: input.interventionOutcome ?? null,
      artifactCount: artifacts.length,
      exitCode: input.exitCode ?? null,
      durationMs: input.durationMs ?? null,
      cpuTimeMs: input.cpuTimeMs ?? null,
      memoryPeakBytes: input.memoryPeakBytes ?? null,
      errorClass: input.errorClass ?? null,
    },
  };
}

function eventOutputArtifactRefs(
  event: RuntimeEvent,
  outputs: DesktopWorkEvidenceProjection["outputArtifacts"],
): EvidenceArtifactRef[] {
  const keys = new Set(findFileOutputs(event.data).map((output) => `${output.id}:${output.revision}`));
  return outputs
    .filter((artifact) => keys.has(`${artifact.output.id}:${artifact.output.revision}`))
    .map((artifact) => artifact.contentRef);
}

function eventValidationArtifactRefs(
  event: RuntimeEvent,
  outputs: DesktopWorkEvidenceProjection["outputArtifacts"],
): EvidenceArtifactRef[] {
  const keys = new Set(findFileOutputs(event.data).map((output) => `${output.id}:${output.revision}`));
  return outputs
    .filter((artifact) => keys.has(`${artifact.output.id}:${artifact.output.revision}`))
    .flatMap((artifact) => artifact.revisionDescriptor.validationEvidenceRefs as EvidenceArtifactRef[]);
}

function isEnvironmentEvent(event: RuntimeEvent): boolean {
  return event.name === "workspace_action"
    || event.name === "workspace_action_result"
    || event.name === "command.output"
    || event.name === "workspace.diff";
}

function agentCallReceiptHash(event: RuntimeEvent): string | null {
  if (event.name !== "tool.started" && event.name !== "tool.completed" && event.name !== "command.output") {
    return null;
  }
  const identity = nestedString(event.data, ["toolCallId", "callId", "id"]);
  return identity ? contentHash(["agent-tool-call", identity]) : null;
}

function environmentReceiptHash(event: RuntimeEvent): string {
  const identity = nestedString(event.data, ["workspaceToolCallId", "operationId", "requestId", "id"])
    ?? event.id;
  return contentHash(["environment-operation", identity]);
}

function environmentLifecycleAction(
  event: RuntimeEvent,
): "environment_created" | "environment_reset" | "environment_destroyed" | "cleanup_completed" | "cleanup_failed" | null {
  const action = (event.action ?? "").toLowerCase();
  const failed = event.status === "failed" || Boolean(event.error);
  if (action === "sandbox_create" || action === "sandbox_template_launch") return "environment_created";
  if (action.includes("sandbox_reset") || action.includes("replay_start")) return "environment_reset";
  if (action === "sandbox_stop") return "environment_destroyed";
  if (action === "work_sandbox_cleanup") return failed ? "cleanup_failed" : "cleanup_completed";
  return null;
}

function environmentExitCode(event: RuntimeEvent): number | null {
  const value = nestedNumber(event.data, ["exitCode", "exit_code", "code"]);
  return value === null ? null : Math.max(-1, Math.min(255, Math.trunc(value)));
}

function environmentDurationMs(event: RuntimeEvent): number | null {
  const direct = nestedNumber(event.data, ["durationMs", "duration_ms"]);
  if (direct !== null) return Math.max(0, Math.trunc(direct));
  const timing = findRecordWithKey(event.data, "workspaceToolTiming");
  const started = timing ? numberFromRecord(timing.workspaceToolTiming, "startedAtMs") : null;
  const completed = timing ? numberFromRecord(timing.workspaceToolTiming, "completedAtMs") : null;
  return started !== null && completed !== null ? Math.max(0, Math.trunc(completed - started)) : null;
}

function environmentCpuTimeMs(event: RuntimeEvent): number | null {
  const value = nestedNumber(event.data, ["cpuTimeMs", "cpu_time_ms"]);
  return value === null ? null : Math.max(0, Math.trunc(value));
}

function environmentMemoryPeakBytes(event: RuntimeEvent): number | null {
  const value = nestedNumber(event.data, [
    "memoryPeakBytes",
    "memory_peak_bytes",
    "peakMemoryBytes",
    "peak_memory_bytes",
  ]);
  return value === null ? null : Math.max(0, Math.trunc(value));
}

function nestedString(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const child of Object.values(record)) {
    const found = nestedString(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function nestedNumber(value: unknown, keys: string[], depth = 0): number | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedNumber(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key];
  }
  for (const child of Object.values(record)) {
    const found = nestedNumber(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findRecordWithKey(value: unknown, key: string, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordWithKey(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (key in record) return record;
  for (const child of Object.values(record)) {
    const found = findRecordWithKey(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function numberFromRecord(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function receiptTerminal(turn: Turn): WorkEvidenceReceipt["terminal"] {
  if (turn.status === "completed") return { status: "completed", failureClass: null };
  if (turn.status === "interrupted") {
    if (/time(?:d)?\s*out/i.test(turn.error ?? "")) return { status: "timeout", failureClass: "timeout" };
    return { status: "cancelled", failureClass: "cancelled" };
  }
  const error = turn.error ?? "";
  const failureClass = /infrastructure|provider unavailable|network/i.test(error)
    ? "infrastructure_failure" as const
    : /environment|sandbox/i.test(error)
    ? "environment_failure" as const
    : /policy|permission|denied/i.test(error)
    ? "policy_failure" as const
    : "model_failure" as const;
  return { status: "failed", failureClass };
}

function receiptTiming(turn: Turn): WorkEvidenceReceipt["timing"] {
  const completedAt = turn.completedAt!;
  return {
    startedAt: turn.startedAt,
    completedAt,
    latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(turn.startedAt)),
  };
}

function usageSummary(records: ModelUsageRecord[]): WorkEvidenceReceipt["usage"] {
  return {
    promptTokens: sumKnown(records.map((record) => record.promptTokens)),
    completionTokens: sumKnown(records.map((record) => record.completionTokens)),
    totalTokens: sumKnown(records.map((record) => record.totalTokens)),
  };
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function modelRef(session: Session, turn: Turn, usage: ModelUsageRecord[]): WorkEvidenceReceipt["model"] {
  const selected = turn.modelRef ?? session.modelRef;
  const fallback = usage[0];
  return {
    provider: selected?.providerId ?? fallback?.provider ?? session.provider,
    model: selected?.modelId ?? fallback?.model ?? "unknown",
    revision: null,
    artifactHash: null,
    tokenizerRevision: null,
    chatTemplateHash: null,
  };
}

function interventionCounts(events: RuntimeEvent[]): WorkEvidenceReceipt["interventions"] {
  return {
    approvals: events.filter((event) => event.name === "approval.resolved").length,
    questions: events.filter((event) => event.name === "user_question.answered" || event.name === "user_question.dismissed").length,
    steeringEvents: events.filter((event) => event.source === "ui_button" || event.source === "chat_action").length,
    otherUserInterventions: 0,
  };
}

function toolCategory(event: RuntimeEvent): WorkProcessStep["attributes"]["toolCategory"] {
  const action = (event.action ?? "").toLowerCase();
  if (event.appId) return "connected_app";
  if (/git|diff|commit|branch|pull_request|repository/.test(action)) return "source_control";
  if (/browser|playwright|chrome|screenshot/.test(action)) return "browser";
  if (/sandbox/.test(action)) return "sandbox";
  if (/command|terminal|shell|exec/.test(action) || event.name === "command.output") return "command";
  if (/file|workspace|directory|path/.test(action)) return "filesystem";
  if (/agent|subagent/.test(action)) return "agent";
  return "other";
}

function hashPresent(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return contentHash(value);
}

function jsonRef(value: unknown, mediaType: string): EvidenceArtifactRef {
  return evidenceArtifactRef({
    contentHash: contentHash(value),
    mediaType,
    sizeBytes: byteLength(value),
  });
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function uniqueArtifacts(refs: EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  return [...new Map(refs.map((ref) => [ref.contentHash, ref])).values()];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function processErrorClass(
  failure: WorkEvidenceReceipt["terminal"]["failureClass"],
): WorkProcessStep["attributes"]["errorClass"] {
  if (!failure) return null;
  if (failure === "policy_failure") return "policy";
  if (failure === "validation_failure") return "validation";
  if (failure === "environment_failure") return "environment";
  if (failure === "infrastructure_failure") return "infrastructure";
  if (failure === "timeout") return "timeout";
  if (failure === "cancelled") return "cancelled";
  return "unknown";
}
