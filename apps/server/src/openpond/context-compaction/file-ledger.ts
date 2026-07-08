import type { CompactionRecord, FileLedgerEntry, FileLedgerOperation } from "./types.js";

export function buildFileOperationLedger(records: readonly CompactionRecord[]): FileLedgerEntry[] {
  const entries = new Map<string, FileLedgerEntry>();

  for (const record of records) {
    const paths = new Set([...record.filePaths, ...extractFilePaths(record.body)]);
    if (paths.size === 0) continue;

    for (const path of paths) {
      const entry = entries.get(path) ?? {
        path,
        operations: [],
        relevance: "referenced" as const,
        latestStatus: "unknown" as const,
        failure: null,
      };
      for (const operation of operationsForRecord(record)) {
        if (!entry.operations.includes(operation)) entry.operations.push(operation);
      }
      const status = statusForRecord(record);
      if (status !== "unknown") entry.latestStatus = status;
      const failure = failureForRecord(record);
      if (failure) {
        entry.failure = failure;
        entry.latestStatus = "failed";
      }
      entry.relevance = relevanceForEntry(entry);
      entries.set(path, entry);
    }
  }

  return [...entries.values()]
    .sort((a, b) => relevanceRank(b.relevance) - relevanceRank(a.relevance) || a.path.localeCompare(b.path))
    .slice(0, 100);
}

function operationsForRecord(record: CompactionRecord): FileLedgerOperation[] {
  const text = `${record.title}\n${record.action ?? ""}\n${record.body}`.toLowerCase();
  const operations: FileLedgerOperation[] = [];
  if (/\b(read|opened|cat|sed|rg|grep|find)\b/.test(text)) operations.push("read");
  if (/\b(edit|edited|write|wrote|patch|apply_patch|created|updated|deleted|rename|move)\b/.test(text)) {
    operations.push("edit");
  }
  if (/\b(diff|git status|git show)\b/.test(text)) operations.push("diff");
  if (/\b(command|exec|shell|bun |npm |pnpm |yarn |pytest|cargo |go test|make )\b/.test(text)) {
    operations.push("command");
  }
  if (/\b(test|typecheck|lint|build|verify|validation|smoke)\b/.test(text)) operations.push("validation");
  if (statusForRecord(record) === "failed") operations.push("failure");
  return operations.length > 0 ? operations : ["read"];
}

function statusForRecord(record: CompactionRecord): FileLedgerEntry["latestStatus"] {
  if (record.status === "failed" || record.kind === "turn_failed") return "failed";
  const text = `${record.title}\n${record.body}`.toLowerCase();
  if (/\b(error|failed|failure|exception|timed out|timeout)\b/.test(text)) return "failed";
  if (/\b(pass|passed|success|succeeded|ok|completed)\b/.test(text)) return "ok";
  return "unknown";
}

function failureForRecord(record: CompactionRecord): string | null {
  if (statusForRecord(record) !== "failed") return null;
  const lines = record.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /\b(error|failed|failure|exception|timed out|timeout)\b/i.test(line))?.slice(0, 240)
    ?? lines[0]?.slice(0, 240)
    ?? "failed";
}

function relevanceForEntry(entry: FileLedgerEntry): FileLedgerEntry["relevance"] {
  if (entry.latestStatus === "failed" || entry.operations.includes("failure")) return "failed";
  if (entry.operations.includes("validation")) return "validation";
  if (entry.operations.some((operation) => operation === "edit" || operation === "diff")) return "active";
  return "referenced";
}

function relevanceRank(value: FileLedgerEntry["relevance"]): number {
  if (value === "failed") return 4;
  if (value === "active") return 3;
  if (value === "validation") return 2;
  return 1;
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

