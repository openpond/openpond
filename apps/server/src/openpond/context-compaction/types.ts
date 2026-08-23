import type { HostedChatMessage } from "@openpond/cloud";
import type { ChatProvider, RuntimeEvent, Session } from "@openpond/contracts";
import type { ContinuationCapsule } from "./continuation-capsule.js";

export type { FileLedgerEntry, FileLedgerOperation } from "./file-ledger-types.js";
import type { FileLedgerEntry } from "./file-ledger-types.js";

export type HostedCompactionProvider = ChatProvider;

export type ContextCompactionStreamDelta = {
  text?: string;
  reasoningText?: string;
  usage?: unknown;
  raw?: unknown;
};

export type ContextCompactionStream = (input: {
  provider: ChatProvider;
  model: string;
  messages: HostedChatMessage[];
  requestId: string;
  signal?: AbortSignal;
}) => AsyncGenerator<ContextCompactionStreamDelta, void, unknown>;

export type CompactionRecordKind =
  | "previous_summary"
  | "user"
  | "assistant"
  | "workspace_activity"
  | "tool_activity"
  | "goal_context"
  | "subagent_activity"
  | "turn_failed"
  | "file_activity"
  | "other";

export type CompactionDurableFactKind =
  | "branch"
  | "command"
  | "endpoint"
  | "error_code"
  | "identifier"
  | "labeled_value"
  | "path"
  | "port"
  | "revision";

export type CompactionDurableFact = {
  kind: CompactionDurableFactKind;
  label: string;
  value: string;
};

export type CompactionRecord = {
  kind: CompactionRecordKind;
  title: string;
  body: string;
  event?: RuntimeEvent;
  eventId?: string;
  turnId?: string | null;
  action?: string | null;
  status?: string | null;
  atomicGroupId?: string | null;
  filePaths: string[];
  durableFacts: CompactionDurableFact[];
  tokenEstimate: number;
  preserveVerbatim?: boolean;
};

export type CompactionMetrics = {
  sourceEvents: number;
  summarizedEvents: number;
  preservedEvents: number;
  sourceRecords: number;
  includedRecords: number;
  omittedRecords: number;
  preservedRecords: number;
  truncatedRecords: number;
  summaryInputTruncated: boolean;
  sourceSelectionStrategy: "newest_useful_v1";
  summaryInputChars: number;
  summaryInputTokens: number;
  retainedTailTokens: number;
  retainedTailBudgetTokens: number;
  finalProviderContextTokens: number;
  durationMs: number;
  fileLedgerEntries: number;
  splitTurnId: string | null;
  tokenSource: "heuristic";
};

export type HostedCompactionResult = {
  summary: string;
  model: string;
  compactedThroughEventId: string | null;
  compactedThroughTurnId: string | null;
  preservedFromEventId: string | null;
  preservedEventIds: string[];
  preservedResourceRefs: string[];
  sourceEventCount: number;
  preservedEventCount: number;
  fileLedger: FileLedgerEntry[];
  continuationCapsule: ContinuationCapsule;
  inputTokensBefore: number;
  inputTokensAfter: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
  metrics: CompactionMetrics;
};

export type HostedAutoCompactionDecision = {
  shouldCompact: boolean;
  projectedTokens: number;
  thresholdTokens: number;
  usableContextTokens: number;
  maxContextTokens: number;
  tokenSource: "heuristic";
};

export type HostedCompactionInput = {
  session: Session;
  events: RuntimeEvent[];
  provider: HostedCompactionProvider;
  model?: string | null;
  maxContextTokens?: number | null;
  signal?: AbortSignal;
  streamCompactionChatTurn?: ContextCompactionStream;
};
