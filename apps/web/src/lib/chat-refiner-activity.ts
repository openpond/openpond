import type { RuntimeEvent } from "@openpond/contracts";

import type { ChatMessage, HarnessRefinerActivity } from "./app-models";
import { asRecord } from "./chat-message-utils";

export function appendHarnessRefinementStatus(
  messages: ChatMessage[],
  item: RuntimeEvent,
): void {
  if (!item.turnId) return;
  removeLegacyStatus(messages, item.turnId);
  const activity = refinerActivityFromEvent(item);
  if (!activity) return;

  const group = findParentWorkGroup(messages, item.turnId);
  if (group) {
    group.refinerActivity = activity;
    return;
  }

  const message: ChatMessage = {
    id: `${item.id}:work-refiner`,
    role: "activity_group",
    activities: [],
    timestamp: item.timestamp,
    turnId: item.turnId,
    traceState: "completed",
    traceStartedAt: item.timestamp,
    traceCompletedAt: item.timestamp,
    refinerActivity: activity,
  };
  const assistantIndex = messages.findIndex(
    (candidate) => candidate.role === "assistant" && candidate.turnId === item.turnId,
  );
  if (assistantIndex >= 0) messages.splice(assistantIndex, 0, message);
  else messages.push(message);
}

export function refinerActivityFromEvent(
  item: RuntimeEvent,
): HarnessRefinerActivity | null {
  const data = asRecord(item.data);
  const display = asRecord(data?.activity);
  if (display) return parseDisplayActivity(display, item);
  return legacyActivity(item, data);
}

export function refinerActivityLabel(activity: HarnessRefinerActivity): string {
  if (activity.state === "running") return "Refiner · Reviewing for a reusable improvement";
  if (activity.state === "failed") return "Refiner · Review failed";
  if (activity.result === "no_action") return "Refiner · No reusable change";
  if (activity.result === "routed") {
    return `Refiner · ${titleCase(activity.route ?? "external")} issue routed`;
  }
  const result = activity.result === "applied" ? "Applied" : "Needs review";
  return `Refiner · ${activity.summary} — ${result}`;
}

function parseDisplayActivity(
  display: Record<string, unknown>,
  item: RuntimeEvent,
): HarnessRefinerActivity | null {
  const state = enumValue(display.state, ["running", "completed", "failed"] as const);
  if (!state) return null;
  const result = state === "failed"
    ? "failed"
    : enumValue(display.result, ["no_action", "routed", "applied", "retained"] as const);
  const reason = stringValue(display.reason) ?? item.output ?? item.error ?? null;
  return {
    state,
    visibility: enumValue(display.visibility, ["always", "material_only"] as const)
      ?? "material_only",
    result: state === "running" ? null : result,
    workspaceId: stringValue(display.workspaceId),
    decision: enumValue(display.decision, ["no_action", "route", "propose"] as const),
    route: stringValue(display.route),
    operation: enumValue(display.operation, ["create", "update", "delete"] as const),
    target: stringValue(display.target),
    summary: stringValue(display.summary) ?? defaultSummary(state, result),
    expectedOutcome: stringValue(display.expectedOutcome),
    reason,
    evidenceBasis: parseEvidenceBasis(display.evidenceBasis),
    critiqueStatus: enumValue(
      display.critiqueStatus,
      ["not_applicable", "pending", "passed", "rejected", "failed"] as const,
    ) ?? (state === "running" ? "pending" : "not_applicable"),
    validationStatus: enumValue(
      display.validationStatus,
      ["not_applicable", "pending", "passed", "failed"] as const,
    ) ?? (state === "running" ? "pending" : "not_applicable"),
    validations: parseValidations(display.validationReceipts),
    edits: parseEdits(display.edits),
    refs: {
      trigger: refLabel(display.trigger),
      outcome: refLabel(display.outcome),
      proposal: refLabel(display.proposal),
      applyReceipt: refLabel(display.applyReceipt),
      advanceReceipt: refLabel(display.advanceReceipt),
      inputHarness: refLabel(display.inputHarness),
      outputHarness: refLabel(display.outputHarness),
    },
  };
}

function legacyActivity(
  item: RuntimeEvent,
  data: Record<string, unknown> | null,
): HarnessRefinerActivity | null {
  if (!item.name.startsWith("harness.refiner.")) return null;
  const failed = item.name === "harness.refiner.failed" || item.status === "failed";
  const completed = item.name === "harness.refiner.completed";
  const outcome = asRecord(data?.outcome);
  const proposal = asRecord(data?.proposal);
  const routed = outcome?.routed === true;
  const workspaceAdvance = stringValue(data?.workspaceAdvance);
  const result = failed
    ? "failed"
    : !completed
      ? null
      : proposal
        ? workspaceAdvance === "advanced" || /\bapplied\b/i.test(item.output ?? "")
          ? "applied"
          : "retained"
        : routed
          ? "routed"
          : "no_action";
  return {
    state: failed ? "failed" : completed ? "completed" : "running",
    visibility: "material_only",
    result,
    workspaceId: null,
    decision: proposal ? "propose" : routed ? "route" : completed ? "no_action" : null,
    route: stringValue(outcome?.route),
    operation: null,
    target: null,
    summary: defaultSummary(failed ? "failed" : completed ? "completed" : "running", result),
    expectedOutcome: null,
    reason: item.output ?? item.error ?? null,
    evidenceBasis: null,
    critiqueStatus: proposal ? "passed" : "not_applicable",
    validationStatus: proposal ? "pending" : "not_applicable",
    validations: [],
    edits: [],
    refs: {
      trigger: refLabel(data?.trigger),
      outcome: refLabel(outcome),
      proposal: refLabel(proposal),
      applyReceipt: null,
      advanceReceipt: null,
      inputHarness: null,
      outputHarness: null,
    },
  };
}

function findParentWorkGroup(
  messages: ChatMessage[],
  turnId: string,
): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    if (
      candidate.role === "activity_group"
      && candidate.turnId === turnId
      && !candidate.activities?.some((activity) => activity.subagentMessage)
    ) {
      return candidate;
    }
  }
  return null;
}

function removeLegacyStatus(messages: ChatMessage[], turnId: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate?.role === "status_divider"
      && candidate.statusKind === "harness_refinement"
      && candidate.turnId === turnId
    ) {
      messages.splice(index, 1);
    }
  }
}

function parseEvidenceBasis(value: unknown): HarnessRefinerActivity["evidenceBasis"] {
  const record = asRecord(value);
  const kind = enumValue(record?.kind, ["single_deterministic", "recurrent_independent"] as const);
  if (!record || !kind) return null;
  return {
    kind,
    supportingEvidenceIds: stringArray(record.supportingEvidenceIds),
    counterevidence: stringArray(record.counterevidence),
  };
}

function parseValidations(value: unknown): HarnessRefinerActivity["validations"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const record = asRecord(candidate);
    const id = stringValue(record?.id);
    const status = enumValue(record?.status, ["passed", "failed", "blocked", "skipped"] as const);
    const summary = stringValue(record?.summary);
    return id && status && summary ? [{ id, status, summary }] : [];
  });
}

function parseEdits(value: unknown): HarnessRefinerActivity["edits"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const record = asRecord(candidate);
    const id = stringValue(record?.id);
    const operation = enumValue(record?.operation, ["create", "update", "delete"] as const);
    const target = stringValue(record?.target);
    const summary = stringValue(record?.summary);
    if (!id || !operation || !target || !summary) return [];
    return [{
      id,
      operation,
      target,
      summary,
      content: typeof record?.content === "string" ? record.content : null,
    }];
  });
}

function refLabel(value: unknown): string | null {
  const record = asRecord(value);
  const id = stringValue(record?.id);
  const contentHash = stringValue(record?.contentHash);
  return id && contentHash ? `${id} · ${contentHash.slice(0, 12)}` : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()))
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | null {
  return typeof value === "string" && values.includes(value) ? value as Values[number] : null;
}

function defaultSummary(
  state: HarnessRefinerActivity["state"],
  result: HarnessRefinerActivity["result"],
): string {
  if (state === "running") return "Reviewing for a reusable improvement";
  if (state === "failed") return "Review failed";
  if (result === "no_action") return "No reusable change";
  if (result === "routed") return "Issue routed";
  return "Harness change";
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
