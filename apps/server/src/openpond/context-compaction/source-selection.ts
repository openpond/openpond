import type { CompactionRecord } from "./types.js";

const MAX_SERIALIZED_EVENT_CHARS = 6_000;
const RECORD_SEPARATOR = "\n\n";
const OPERATIONAL_SIGNAL = /\b(?:block(?:ed|er)?|constraint|decision|do not|don't|never|must|next (?:action|step)|pending|retry|validation|failed|failure|error|unresolved)\b/i;

export type SerializedCompactionRecords = {
  text: string;
  inputChars: number;
  sourceRecordCount: number;
  includedRecordCount: number;
  omittedRecordCount: number;
  truncatedRecordCount: number;
  inputTruncated: boolean;
  selectionStrategy: "newest_useful_v1";
};

type RenderedRecord = {
  index: number;
  record: CompactionRecord;
  text: string;
  truncated: boolean;
};

type AtomicRecordGroup = {
  key: string;
  records: RenderedRecord[];
  newestIndex: number;
  priority: number;
};

export function serializeRecordsForCompaction(
  records: readonly CompactionRecord[],
  maxInputChars: number,
): SerializedCompactionRecords {
  const budget = Math.max(0, Math.floor(maxInputChars));
  const rendered = records.map(renderRecord);
  const fullText = joinRecords(rendered);
  if (fullText.length <= budget) return result(rendered, records.length, fullText);

  const latestUserIndex = findLatestUserIndex(rendered);
  const groups = atomicGroups(rendered, latestUserIndex).sort(compareGroups);
  const selected: RenderedRecord[] = [];
  let selectedChars = 0;

  for (const group of groups) {
    const groupChars = group.records.reduce((total, item) => total + item.text.length, 0);
    const addedSeparators = RECORD_SEPARATOR.length * (selected.length === 0
      ? Math.max(0, group.records.length - 1)
      : group.records.length);
    if (selectedChars + groupChars + addedSeparators > budget) continue;
    selected.push(...group.records);
    selectedChars += groupChars + addedSeparators;
  }

  selected.sort((left, right) => left.index - right.index);
  const text = joinRecords(selected);
  return result(selected, records.length, text);
}

function result(
  included: readonly RenderedRecord[],
  sourceRecordCount: number,
  text: string,
): SerializedCompactionRecords {
  const omittedRecordCount = Math.max(0, sourceRecordCount - included.length);
  const truncatedRecordCount = included.filter((item) => item.truncated).length;
  return {
    text,
    inputChars: text.length,
    sourceRecordCount,
    includedRecordCount: included.length,
    omittedRecordCount,
    truncatedRecordCount,
    inputTruncated: omittedRecordCount > 0 || truncatedRecordCount > 0,
    selectionStrategy: "newest_useful_v1",
  };
}

function renderRecord(record: CompactionRecord, index: number): RenderedRecord {
  const metadata = record.event
    ? [
        record.turnId ? `turn=${record.turnId}` : null,
        record.action ? `action=${record.action}` : null,
        record.status ? `status=${record.status}` : null,
      ].filter(Boolean).join(" ")
    : "";
  const prefix = metadata ? `### ${record.title} (${metadata})` : `### ${record.title}`;
  const body = record.body.trim();
  const truncated = body.length > MAX_SERIALIZED_EVENT_CHARS;
  const renderedBody = truncated
    ? `${body.slice(0, MAX_SERIALIZED_EVENT_CHARS)}\n[record truncated]`
    : body;
  return {
    index,
    record,
    text: `${prefix}\n${renderedBody}`,
    truncated,
  };
}

function atomicGroups(
  records: readonly RenderedRecord[],
  latestUserIndex: number,
): AtomicRecordGroup[] {
  const groups = new Map<string, AtomicRecordGroup>();
  for (const item of records) {
    const key = item.record.atomicGroupId
      ? `atomic:${item.record.atomicGroupId}`
      : `record:${item.index}`;
    const priority = recordPriority(item, latestUserIndex);
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(item);
      existing.newestIndex = Math.max(existing.newestIndex, item.index);
      existing.priority = Math.max(existing.priority, priority);
      continue;
    }
    groups.set(key, {
      key,
      records: [item],
      newestIndex: item.index,
      priority,
    });
  }
  return [...groups.values()];
}

function recordPriority(item: RenderedRecord, latestUserIndex: number): number {
  const { record } = item;
  if (record.kind === "previous_summary") return 700;
  if (record.kind === "goal_context") return 650;
  if (record.kind === "turn_failed" || record.status === "failed") return 625;
  if (record.preserveVerbatim || OPERATIONAL_SIGNAL.test(`${record.title}\n${record.body}`)) return 600;
  if (record.durableFacts.length > 0) return 590 + Math.min(9, record.durableFacts.length);
  if (record.kind === "user" && item.index === latestUserIndex) return 575;
  if (record.filePaths.length > 0) return 525;
  if (record.kind === "subagent_activity") return 475;
  if (record.kind === "workspace_activity" || record.kind === "tool_activity") return 450;
  if (record.kind === "user") return 425;
  if (record.kind === "assistant") return 400;
  return 300;
}

function compareGroups(left: AtomicRecordGroup, right: AtomicRecordGroup): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.newestIndex !== right.newestIndex) return right.newestIndex - left.newestIndex;
  return left.key.localeCompare(right.key);
}

function findLatestUserIndex(records: readonly RenderedRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.record.kind === "user") return records[index]!.index;
  }
  return -1;
}

function joinRecords(records: readonly RenderedRecord[]): string {
  return records.map((item) => item.text).join(RECORD_SEPARATOR);
}
