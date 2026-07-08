import {
  SubagentRunSchema,
  type RuntimeEvent,
  type SubagentRef,
  type SubagentRun,
} from "@openpond/contracts";
import { formatPromptWithAttachmentContext } from "../../chat-attachments.js";
import { textFromUnknown } from "../../utils.js";
import { estimateTextTokens } from "./metrics.js";
import type { CompactionRecord } from "./types.js";

const MAX_SERIALIZED_EVENT_CHARS = 6_000;

export type SerializedCompactionRecords = {
  text: string;
  inputChars: number;
  includedRecordCount: number;
  truncated: boolean;
};

export function normalizeCompactionRecords(events: RuntimeEvent[]): CompactionRecord[] {
  const records: CompactionRecord[] = [];

  for (const item of events) {
    if (item.name === "session.context.updated" || item.name === "session.compaction.started") continue;
    if (item.name === "session.compaction.failed") continue;
    if (item.name === "diagnostic") continue;

    if (item.name === "session.compaction.completed") {
      const summary = summaryFromCompactionEvent(item);
      if (summary) records.push(record("previous_summary", "Previous Summary", summary));
      continue;
    }

    if (item.name === "turn.started") {
      const prompt = typeof item.args?.prompt === "string" ? item.args.prompt : "";
      const attachmentContext =
        typeof item.args?.attachmentContext === "string" ? item.args.attachmentContext : "";
      records.push(record("user", "User", formatPromptWithAttachmentContext(prompt, attachmentContext), item));
      continue;
    }

    if (item.name === "assistant.delta") {
      records.push(record("assistant", "Assistant", item.output ?? "", item));
      continue;
    }

    if (item.name === "workspace_action" || item.name === "workspace_action_result") {
      records.push(record("workspace_activity", "Workspace Activity", eventPreview(item), item));
      continue;
    }

    if (item.name === "tool.started" || item.name === "tool.completed" || item.name === "command.output") {
      records.push(record("tool_activity", "Tool Activity", eventPreview(item), item));
      continue;
    }

    if (isGoalContextEvent(item)) {
      records.push(record("goal_context", "Goal Context", goalContextPreview(item), item, true));
      continue;
    }

    if (item.name.startsWith("subagent.")) {
      records.push(record("subagent_activity", "Subagent Activity", subagentEventPreview(item), item, true));
      continue;
    }

    if (item.name === "turn.failed") {
      records.push(record("turn_failed", "Turn Failed", item.error ?? item.output ?? "", item, true));
      continue;
    }

    records.push(record("other", item.name, eventPreview(item), item));
  }

  return records;
}

export function serializeRecordsForCompaction(
  records: readonly CompactionRecord[],
  maxInputChars: number,
): SerializedCompactionRecords {
  const lines: string[] = [];
  let totalChars = 0;
  let includedRecordCount = 0;
  let truncated = false;

  function append(block: string): void {
    if (!block.trim() || totalChars >= maxInputChars) return;
    const remaining = maxInputChars - totalChars;
    const value =
      block.length > remaining
        ? `${block.slice(0, Math.max(0, remaining - 32))}\n[compaction input truncated]`
        : block;
    if (block.length > remaining) truncated = true;
    lines.push(value);
    totalChars += value.length;
    includedRecordCount += 1;
  }

  for (const item of records) {
    append(section(item));
  }

  return {
    text: lines.join("\n\n"),
    inputChars: totalChars,
    includedRecordCount,
    truncated,
  };
}

export function eventsForHostedCompaction(events: RuntimeEvent[]): RuntimeEvent[] {
  const compacted = latestCompletedCompaction(events);
  if (!compacted) return events;

  if (compacted.preservedEventIds.length > 0) {
    const preservedIds = new Set(compacted.preservedEventIds);
    const preservedIndex = compacted.preservedFromEventId
      ? events.findIndex((item) => item.id === compacted.preservedFromEventId)
      : -1;
    const replayStart = preservedIndex >= 0 && preservedIndex < compacted.index ? preservedIndex : compacted.index + 1;
    return [
      compacted.event,
      ...events.slice(replayStart, compacted.index).filter((item) => preservedIds.has(item.id)),
      ...events.slice(compacted.index + 1),
    ];
  }

  const preservedIndex = compacted.preservedFromEventId
    ? events.findIndex((item) => item.id === compacted.preservedFromEventId)
    : -1;
  const replayStart = preservedIndex >= 0 && preservedIndex < compacted.index ? preservedIndex : compacted.index + 1;
  return [compacted.event, ...events.slice(replayStart, compacted.index), ...events.slice(compacted.index + 1)];
}

export function durableResourceRefs(events: RuntimeEvent[]): string[] {
  const refs = new Set<string>();
  for (const item of events) {
    if (isGoalContextEvent(item) && item.id) refs.add(`goal-context:${item.id}`);
    collectSubagentRefs(item, refs);
    collectResourceRefs(item.data, refs);
    collectResourceRefs(item.args, refs);
  }
  return [...refs].slice(0, 100);
}

export function lastTurnId(events: readonly RuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turnId = events[index]?.turnId;
    if (turnId) return turnId;
  }
  return null;
}

export function summaryFromCompactionEvent(event: RuntimeEvent): string | null {
  if (!event.data || typeof event.data !== "object") return null;
  const summary = (event.data as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

export function preservedFromCompactionEvent(event: RuntimeEvent): string | null {
  if (!event.data || typeof event.data !== "object") return null;
  const preservedFromEventId = (event.data as { preservedFromEventId?: unknown }).preservedFromEventId;
  return typeof preservedFromEventId === "string" && preservedFromEventId.trim() ? preservedFromEventId : null;
}

export function preservedEventIdsFromCompactionEvent(event: RuntimeEvent): string[] {
  if (!event.data || typeof event.data !== "object") return [];
  const value = (event.data as { preservedEventIds?: unknown }).preservedEventIds;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function eventPreview(event?: RuntimeEvent): string {
  if (!event) return "";
  const parts = [event.output, event.error, event.action, event.data ? textFromUnknown(event.data) : null].filter(
    (value): value is string => Boolean(value),
  );
  return parts.join("\n");
}

function latestCompletedCompaction(events: RuntimeEvent[]): {
  event: RuntimeEvent;
  index: number;
  preservedFromEventId: string | null;
  preservedEventIds: string[];
} | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    if (item.name !== "session.compaction.completed" || !summaryFromCompactionEvent(item)) continue;
    return {
      event: item,
      index,
      preservedFromEventId: preservedFromCompactionEvent(item),
      preservedEventIds: preservedEventIdsFromCompactionEvent(item),
    };
  }
  return null;
}

function record(
  kind: CompactionRecord["kind"],
  title: string,
  body: string,
  event?: RuntimeEvent,
  preserveVerbatim = false,
): CompactionRecord {
  const normalizedBody = body.trim() || eventPreview(event);
  return {
    kind,
    title,
    body: normalizedBody,
    event,
    eventId: event?.id,
    turnId: event?.turnId ?? null,
    action: event?.action ?? null,
    status: event?.status ?? null,
    filePaths: extractFilePaths(`${title}\n${normalizedBody}`),
    tokenEstimate: estimateTextTokens(`${title}\n${normalizedBody}`),
    preserveVerbatim,
  };
}

function section(record: CompactionRecord): string {
  const metadata = record.event
    ? [
        record.turnId ? `turn=${record.turnId}` : null,
        record.action ? `action=${record.action}` : null,
        record.status ? `status=${record.status}` : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const prefix = metadata ? `### ${record.title} (${metadata})` : `### ${record.title}`;
  return `${prefix}\n${truncate(record.body.trim() || eventPreview(record.event), MAX_SERIALIZED_EVENT_CHARS)}`;
}

function isGoalContextEvent(event: RuntimeEvent): boolean {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return false;
  const kind = (event.data as { kind?: unknown }).kind;
  return kind === "goal_context" || kind === "thread_goal";
}

function goalContextPreview(event: RuntimeEvent): string {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return event.output ?? "";
  const data = event.data as Record<string, unknown>;
  const ref = event.id ? `goal-context:${event.id}` : null;
  return [ref ? `ref: ${ref}` : null, event.output, textFromUnknown(data)].filter(Boolean).join("\n");
}

function subagentEventPreview(event: RuntimeEvent): string {
  const run = subagentRunFromEvent(event);
  if (!run) return eventPreview(event);
  const usage = asRecord(run.metadata.usage);
  const report = run.report;
  return [
    `run: subagent-run:${run.id}`,
    `role: ${run.roleId}`,
    `status: ${run.status}`,
    run.parentGoalId ? `parent goal: ${run.parentGoalId}` : null,
    run.childSessionId ? `child session: session:${run.childSessionId}` : null,
    `objective: ${run.objective}`,
    report?.summary ? `summary: ${report.summary}` : null,
    report?.findings.length ? `findings: ${report.findings.slice(0, 6).join(" | ")}` : null,
    report?.blockers.length ? `blockers: ${report.blockers.slice(0, 6).join(" | ")}` : null,
    report?.testsRun.length ? `tests: ${report.testsRun.slice(0, 6).join(" | ")}` : null,
    subagentRefsPreview(report?.artifacts, "artifacts"),
    subagentRefPreview(report?.patchRef, "patch"),
    subagentRefPreview(report?.diffRef, "diff"),
    usage ? subagentUsagePreview(usage) : null,
    run.error ? `error: ${run.error}` : null,
  ].filter(Boolean).join("\n");
}

function collectSubagentRefs(event: RuntimeEvent, refs: Set<string>): void {
  if (!event.name.startsWith("subagent.")) return;
  const run = subagentRunFromEvent(event);
  if (!run) return;
  refs.add(`subagent-run:${run.id}`);
  if (run.childSessionId) refs.add(`session:${run.childSessionId}`);
  for (const ref of [
    ...(run.report?.artifacts ?? []),
    run.report?.patchRef ?? null,
    run.report?.diffRef ?? null,
  ]) {
    if (!ref) continue;
    refs.add(subagentDurableRef(ref));
  }
}

function collectResourceRefs(value: unknown, refs: Set<string>): void {
  if (!value) return;
  if (typeof value === "string") {
    if (isDurableResourceRef(value)) refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResourceRefs(item, refs);
    return;
  }
  if (typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectResourceRefs(child, refs);
  }
}

function isDurableResourceRef(value: string): boolean {
  return /^(workspace:(?:file|dir):|sandbox:(?:file|dir):|git:|event:|message:|artifact:|goal-context:|session:|subagent-run:)/.test(value);
}

function subagentRunFromEvent(event: RuntimeEvent): SubagentRun | null {
  const data = asRecord(event.data);
  const parsed = SubagentRunSchema.safeParse(asRecord(data?.run));
  return parsed.success ? parsed.data : null;
}

function subagentRefsPreview(refs: readonly SubagentRef[] | null | undefined, label: string): string | null {
  if (!refs?.length) return null;
  return `${label}: ${refs.slice(0, 8).map((ref) => `${ref.kind}:${ref.id} (${ref.label})`).join(" | ")}`;
}

function subagentRefPreview(ref: SubagentRef | null | undefined, label: string): string | null {
  return ref ? `${label}: ${ref.kind}:${ref.id} (${ref.label})` : null;
}

function subagentDurableRef(ref: SubagentRef): string {
  if (ref.kind === "session") return `session:${ref.id}`;
  if (ref.kind === "artifact") return `artifact:${ref.id}`;
  if (ref.kind === "turn") return `event:${ref.id}`;
  if (ref.kind === "diff") return `git:diff:${ref.id}`;
  return ref.id.startsWith("workspace:") || ref.id.startsWith("sandbox:") ? ref.id : `workspace:file:${ref.id}`;
}

function subagentUsagePreview(usage: Record<string, unknown>): string | null {
  const totalTokens = numberValue(usage.totalTokens);
  const requestCount = numberValue(usage.requestCount);
  if (totalTokens <= 0 && requestCount <= 0) return null;
  return `usage: ${totalTokens} tokens across ${requestCount} ${requestCount === 1 ? "request" : "requests"}`;
}

function extractFilePaths(value: string): string[] {
  const paths = new Set<string>();
  const durableRefPattern = /\b(?:workspace|sandbox):(file|dir):[^\s,)"']+/g;
  for (const match of value.matchAll(durableRefPattern)) {
    paths.add(match[0]);
  }
  const repoPathPattern = /\b(?:apps|packages|tests|scripts|docs|config|src)\/[A-Za-z0-9._/@+-]+/g;
  for (const match of value.matchAll(repoPathPattern)) {
    paths.add(match[0]);
  }
  const absolutePathPattern = /(?:^|\s)(\/(?:[A-Za-z0-9._@+-]+\/){1,}[A-Za-z0-9._@+-]+)/g;
  for (const match of value.matchAll(absolutePathPattern)) {
    paths.add(match[1]!);
  }
  return [...paths].slice(0, 20);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

