import type { RuntimeEvent, Session } from "@openpond/contracts";

import { textFromUnknown } from "../../utils.js";
import type { FileLedgerEntry } from "./types.js";

export const CONTINUATION_CAPSULE_SCHEMA_VERSION = "openpond.continuation.v1" as const;

export type ContinuationCapsuleFile = {
  path: string;
  operations: FileLedgerEntry["operations"];
  relevance: FileLedgerEntry["relevance"];
  latestStatus: FileLedgerEntry["latestStatus"];
  failure: string | null;
  sourceEventIds: string[];
};

export type ContinuationCapsuleBlockedAction = {
  action: string;
  error: string;
  retryCondition: string | null;
  sourceEventIds: string[];
};

export type ContinuationCapsuleValidation = {
  action: string;
  status: "passed" | "failed" | "unknown";
  detail: string | null;
  sourceEventIds: string[];
};

export type ContinuationCapsule = {
  schemaVersion: typeof CONTINUATION_CAPSULE_SCHEMA_VERSION;
  workspace: {
    kind: Exclude<Session["workspaceKind"], undefined> | null;
    id: string | null;
    name: string | null;
    cwd: string | null;
  };
  currentGoal: string | null;
  latestUserRequest: string | null;
  constraints: string[];
  decisions: string[];
  activeFiles: ContinuationCapsuleFile[];
  blockedActions: ContinuationCapsuleBlockedAction[];
  validations: ContinuationCapsuleValidation[];
  immediateNextActions: string[];
  durableResourceRefs: string[];
  source: {
    compactedThroughEventId: string | null;
    compactedThroughTurnId: string | null;
    preservedFromEventId: string | null;
    preservedEventIds: string[];
  };
};

export function buildContinuationCapsule(input: {
  session: Session;
  events: RuntimeEvent[];
  summary: string;
  fileLedger: FileLedgerEntry[];
  preservedResourceRefs: string[];
  compactedThroughEventId: string | null;
  compactedThroughTurnId: string | null;
  preservedFromEventId: string | null;
  preservedEventIds: string[];
}): ContinuationCapsule {
  const previous = latestContinuationCapsule(input.events);
  const summary = summarySections(input.summary);
  const currentFiles = input.fileLedger.map((entry) => ({
    ...entry,
    operations: [...entry.operations].sort(),
    sourceEventIds: sourceEventIdsForText(input.events, entry.path),
  }));
  const validations = mergeByKey(
    previous?.validations ?? [],
    validationsFromEvents(input.events),
    (item) => item.action,
  );
  const blockedActions = mergeBlockedActions(
    previous?.blockedActions ?? [],
    blockedActionsFromEvents(input.events),
    validations,
  );
  const explicitNextActions = nextActionsFromEvents(input.events);
  const nextActions = uniqueBounded(
    explicitNextActions.length > 0
      ? [...explicitNextActions, ...summary.nextActions]
      : summary.nextActions.length > 0
        ? summary.nextActions
        : previous?.immediateNextActions ?? [],
    12,
  );

  return {
    schemaVersion: CONTINUATION_CAPSULE_SCHEMA_VERSION,
    workspace: {
      kind: input.session.workspaceKind ?? null,
      id: input.session.workspaceId ?? null,
      name: input.session.workspaceName ?? null,
      cwd: input.session.cwd,
    },
    currentGoal: summary.goal ?? previous?.currentGoal ?? null,
    latestUserRequest: latestUserRequest(input.events) ?? previous?.latestUserRequest ?? null,
    constraints: uniqueBounded([...summary.constraints, ...(previous?.constraints ?? [])], 20),
    decisions: uniqueBounded([...summary.decisions, ...(previous?.decisions ?? [])], 20),
    activeFiles: mergeFiles(previous?.activeFiles ?? [], currentFiles).slice(0, 100),
    blockedActions: blockedActions.slice(0, 30),
    validations: validations.slice(0, 40),
    immediateNextActions: nextActions,
    durableResourceRefs: uniqueBounded(
      [...input.preservedResourceRefs, ...(previous?.durableResourceRefs ?? [])].sort(),
      100,
    ),
    source: {
      compactedThroughEventId: input.compactedThroughEventId,
      compactedThroughTurnId: input.compactedThroughTurnId,
      preservedFromEventId: input.preservedFromEventId,
      preservedEventIds: [...input.preservedEventIds],
    },
  };
}

export function renderContinuationCapsule(capsule: ContinuationCapsule): string {
  return [
    "Exact OpenPond continuation state:",
    "Treat identifiers, paths, commands, errors, constraints, retry conditions, and next actions below as authoritative. Reproduce them verbatim when asked.",
    "<openpond-continuation-capsule>",
    JSON.stringify(capsule),
    "</openpond-continuation-capsule>",
  ].join("\n");
}

export function parseContinuationCapsule(value: unknown): ContinuationCapsule | null {
  if (!isRecord(value) || value.schemaVersion !== CONTINUATION_CAPSULE_SCHEMA_VERSION) return null;
  const workspace = value.workspace;
  const source = value.source;
  if (!isRecord(workspace)) return null;
  if (workspace.kind !== null && typeof workspace.kind !== "string") return null;
  if (workspace.cwd !== null && typeof workspace.cwd !== "string") return null;
  if (!isRecord(source)) return null;
  return {
    schemaVersion: CONTINUATION_CAPSULE_SCHEMA_VERSION,
    workspace: {
      kind: workspace.kind as Exclude<Session["workspaceKind"], undefined> | null,
      id: stringOrNull(workspace.id),
      name: stringOrNull(workspace.name),
      cwd: workspace.cwd as string | null,
    },
    currentGoal: stringOrNull(value.currentGoal),
    latestUserRequest: stringOrNull(value.latestUserRequest),
    constraints: stringArray(value.constraints, 20),
    decisions: stringArray(value.decisions, 20),
    activeFiles: parseFiles(value.activeFiles),
    blockedActions: parseBlockedActions(value.blockedActions),
    validations: parseValidations(value.validations),
    immediateNextActions: stringArray(value.immediateNextActions, 12),
    durableResourceRefs: stringArray(value.durableResourceRefs, 100),
    source: {
      compactedThroughEventId: stringOrNull(source.compactedThroughEventId),
      compactedThroughTurnId: stringOrNull(source.compactedThroughTurnId),
      preservedFromEventId: stringOrNull(source.preservedFromEventId),
      preservedEventIds: stringArray(source.preservedEventIds, 500),
    },
  };
}

export function continuationCapsuleFromEventData(value: unknown): ContinuationCapsule | null {
  if (!isRecord(value)) return null;
  return parseContinuationCapsule(value.continuationCapsule);
}

function latestContinuationCapsule(events: RuntimeEvent[]): ContinuationCapsule | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== "session.compaction.completed") continue;
    const capsule = continuationCapsuleFromEventData(event.data);
    if (capsule) return capsule;
  }
  return null;
}

function mergeFiles(
  previous: ContinuationCapsuleFile[],
  current: ContinuationCapsuleFile[],
): ContinuationCapsuleFile[] {
  const byPath = new Map(previous.map((item) => [item.path, item]));
  for (const item of current) {
    const prior = byPath.get(item.path);
    byPath.set(item.path, {
      ...item,
      operations: [...new Set([...(prior?.operations ?? []), ...item.operations])].sort(),
      sourceEventIds: uniqueBounded([...(prior?.sourceEventIds ?? []), ...item.sourceEventIds], 20),
    });
  }
  return [...byPath.values()].sort((left, right) =>
    relevanceRank(right.relevance) - relevanceRank(left.relevance) || left.path.localeCompare(right.path)
  );
}

function blockedActionsFromEvents(events: RuntimeEvent[]): ContinuationCapsuleBlockedAction[] {
  const blocked: ContinuationCapsuleBlockedAction[] = [];
  for (const event of events) {
    const action = event.action?.trim();
    if (!action || !isFailureEvent(event)) continue;
    const body = eventText(event);
    const relatedText = events
      .filter((candidate) => eventText(candidate).includes(action) || candidate.id === event.id)
      .map(eventText)
      .join("\n");
    const explicitlyBlocked = /\b(do not retry|don't retry|retry is blocked|retry blocked)\b/i.test(`${body}\n${relatedText}`);
    if (!explicitlyBlocked) continue;
    blocked.push({
      action,
      error: failureDetail(event),
      retryCondition: retryConditionForAction(action, events),
      sourceEventIds: uniqueBounded(
        events.filter((candidate) => eventText(candidate).includes(action) || candidate.id === event.id).map((item) => item.id),
        20,
      ),
    });
  }
  return mergeByKey([], blocked, (item) => item.action);
}

function mergeBlockedActions(
  previous: ContinuationCapsuleBlockedAction[],
  current: ContinuationCapsuleBlockedAction[],
  validations: ContinuationCapsuleValidation[],
): ContinuationCapsuleBlockedAction[] {
  const passed = new Set(validations.filter((item) => item.status === "passed").map((item) => item.action));
  return mergeByKey(previous, current, (item) => item.action)
    .filter((item) => !passed.has(item.action))
    .sort((left, right) => left.action.localeCompare(right.action));
}

function validationsFromEvents(events: RuntimeEvent[]): ContinuationCapsuleValidation[] {
  const values: ContinuationCapsuleValidation[] = [];
  for (const event of events) {
    const action = event.action?.trim();
    if (!action || !isValidationAction(action)) continue;
    values.push({
      action,
      status: validationStatus(event),
      detail: validationDetail(event),
      sourceEventIds: [event.id],
    });
  }
  return mergeByKey([], values, (item) => item.action);
}

function nextActionsFromEvents(events: RuntimeEvent[]): string[] {
  const values: string[] = [];
  const patterns = [
    /\bnext (?:safe )?(?:action|step)(?: is|:)\s*([^\n.]+)/i,
    /\bnext validation command(?: is|:)\s*([^\n.]+)/i,
    /\bimmediate next action(?: is|:)\s*([^\n.]+)/i,
  ];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = eventText(events[index]!);
    for (const pattern of patterns) {
      const match = text.match(pattern)?.[1]?.trim();
      if (match) values.push(match);
    }
  }
  return uniqueBounded(values, 12);
}

function latestUserRequest(events: RuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== "turn.started") continue;
    const prompt = typeof event.args?.prompt === "string" ? event.args.prompt.trim() : "";
    if (prompt) return bounded(prompt, 2_000);
  }
  return null;
}

function summarySections(summary: string): {
  goal: string | null;
  constraints: string[];
  decisions: string[];
  nextActions: string[];
} {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const rawLine of summary.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,4}\s+(.+)$/)?.[1]?.trim().toLowerCase();
    if (heading) {
      current = heading;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (!line || !current) continue;
    sections.get(current)?.push(line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
  }
  const values = (...names: string[]) => names.flatMap((name) => sections.get(name) ?? []);
  return {
    goal: values("goal", "objective")[0] ?? null,
    constraints: uniqueBounded(values("constraints & preferences", "constraints", "important details"), 20),
    decisions: uniqueBounded(values("key decisions", "decisions"), 20),
    nextActions: uniqueBounded(values("next steps", "next move"), 12),
  };
}

function retryConditionForAction(action: string, events: RuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = eventText(events[index]!);
    if (!text.includes(action) && !/\bretry\b/i.test(text)) continue;
    const condition = text.match(/\buntil\s+([^\n.]+)/i)?.[1]?.trim();
    if (condition) return `until ${condition}`;
  }
  return null;
}

function sourceEventIdsForText(events: RuntimeEvent[], value: string): string[] {
  return events.filter((event) => eventText(event).includes(value)).map((event) => event.id).slice(0, 20);
}

function eventText(event: RuntimeEvent): string {
  return [
    event.action,
    event.error,
    event.output,
    event.args ? textFromUnknown(event.args) : null,
    event.data ? textFromUnknown(event.data) : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function isFailureEvent(event: RuntimeEvent): boolean {
  return event.name === "turn.failed"
    || event.status === "failed"
    || /\b(error|failed|failure|exception|timed out|timeout)\b/i.test(eventText(event));
}

function failureDetail(event: RuntimeEvent): string {
  const values = [event.error, event.output].filter((value): value is string => Boolean(value?.trim()));
  return bounded(values[0]?.trim() ?? "failed", 500);
}

function isValidationAction(action: string): boolean {
  return /(^|\s)(test|typecheck|lint|build|check|verify)(\s|:|$)|\b(pnpm|npm|yarn|bun|cargo|go|pytest)\b.*\b(test|check|lint|build)\b/i.test(action);
}

function validationStatus(event: RuntimeEvent): ContinuationCapsuleValidation["status"] {
  if (isFailureEvent(event)) return "failed";
  if (event.status === "completed" || /\b(pass|passed|success|succeeded|ok)\b/i.test(eventText(event))) {
    return "passed";
  }
  return "unknown";
}

function validationDetail(event: RuntimeEvent): string | null {
  const value = event.error ?? event.output;
  return value?.trim() ? bounded(value.trim(), 500) : null;
}

function mergeByKey<T>(previous: T[], current: T[], key: (item: T) => string): T[] {
  const values = new Map(previous.map((item) => [key(item), item]));
  for (const item of current) values.set(key(item), item);
  return [...values.values()];
}

function uniqueBounded(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function relevanceRank(value: FileLedgerEntry["relevance"]): number {
  if (value === "failed") return 4;
  if (value === "active") return 3;
  if (value === "validation") return 2;
  return 1;
}

function parseFiles(value: unknown): ContinuationCapsuleFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string") return [];
    const operations = stringArray(item.operations, 10).filter((operation): operation is FileLedgerEntry["operations"][number] =>
      ["read", "edit", "diff", "command", "validation", "failure"].includes(operation)
    );
    const relevance = ["referenced", "active", "validation", "failed"].includes(String(item.relevance))
      ? item.relevance as FileLedgerEntry["relevance"]
      : "referenced";
    const latestStatus = ["unknown", "ok", "failed"].includes(String(item.latestStatus))
      ? item.latestStatus as FileLedgerEntry["latestStatus"]
      : "unknown";
    return [{
      path: item.path,
      operations,
      relevance,
      latestStatus,
      failure: stringOrNull(item.failure),
      sourceEventIds: stringArray(item.sourceEventIds, 20),
    }];
  }).slice(0, 100);
}

function parseBlockedActions(value: unknown): ContinuationCapsuleBlockedAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item.action === "string" && typeof item.error === "string"
      ? [{
          action: item.action,
          error: item.error,
          retryCondition: stringOrNull(item.retryCondition),
          sourceEventIds: stringArray(item.sourceEventIds, 20),
        }]
      : []
  ).slice(0, 30);
}

function parseValidations(value: unknown): ContinuationCapsuleValidation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.action !== "string") return [];
    const status = ["passed", "failed", "unknown"].includes(String(item.status))
      ? item.status as ContinuationCapsuleValidation["status"]
      : "unknown";
    return [{
      action: item.action,
      status,
      detail: stringOrNull(item.detail),
      sourceEventIds: stringArray(item.sourceEventIds, 20),
    }];
  }).slice(0, 40);
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
