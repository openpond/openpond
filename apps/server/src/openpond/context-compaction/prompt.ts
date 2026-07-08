import type { HostedChatMessage } from "@openpond/cloud";
import type { FileLedgerEntry } from "./types.js";

const MAX_COMPACTION_INPUT_CHARS = 180_000;
const MIN_COMPACTION_INPUT_CHARS = 12_000;
const COMPACTION_INPUT_CHARS_PER_CONTEXT_TOKEN = 3;

export const COMPACTION_SYSTEM_PROMPT = [
  "You compact conversation history for OpenPond App.",
  "Write a concise continuation summary that preserves everything needed for future turns.",
  "Preserve exact user goals, constraints, decisions, file paths, app ids, branch names, command names, errors, tool outcomes, and pending work.",
  "Remove stale or contradicted details. Do not claim work is complete unless the transcript supports it.",
  "Do not mention that compaction happened.",
  "Use terse markdown bullets under these headings: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context, Relevant Files.",
].join("\n");

export function compactionInputCharBudget(maxContextTokens: number): number {
  return Math.min(
    MAX_COMPACTION_INPUT_CHARS,
    Math.max(MIN_COMPACTION_INPUT_CHARS, Math.floor(maxContextTokens * COMPACTION_INPUT_CHARS_PER_CONTEXT_TOKEN)),
  );
}

export function buildCompactionSummaryMessages(input: {
  serializedHistory: string;
  fileLedger: FileLedgerEntry[];
}): HostedChatMessage[] {
  return [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Compact the following OpenPond App transcript into a durable continuation summary.",
        "The recent tail that remains outside the summary is not included here.",
        "",
        renderFileLedger(input.fileLedger),
        input.serializedHistory,
      ].filter(Boolean).join("\n"),
    },
  ];
}

function renderFileLedger(entries: FileLedgerEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.slice(0, 80).map((entry) => {
    const flags = [
      entry.operations.join(", "),
      entry.relevance,
      entry.latestStatus !== "unknown" ? entry.latestStatus : null,
      entry.failure ? `failure: ${entry.failure}` : null,
    ].filter(Boolean).join("; ");
    return `- ${entry.path}: ${flags}`;
  });
  return ["## Relevant Files", ...lines, ""].join("\n");
}

