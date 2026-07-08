import type { HostedChatMessage } from "@openpond/cloud";
import type { ChatProvider, RuntimeEvent, Session } from "@openpond/contracts";

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

export type CompactionRecord = {
  kind: CompactionRecordKind;
  title: string;
  body: string;
  event?: RuntimeEvent;
  eventId?: string;
  turnId?: string | null;
  action?: string | null;
  status?: string | null;
  filePaths: string[];
  tokenEstimate: number;
  preserveVerbatim?: boolean;
};

export type FileLedgerOperation = "read" | "edit" | "diff" | "command" | "validation" | "failure";

export type FileLedgerEntry = {
  path: string;
  operations: FileLedgerOperation[];
  relevance: "referenced" | "active" | "validation" | "failed";
  latestStatus: "unknown" | "ok" | "failed";
  failure: string | null;
};

export type CompactionMetrics = {
  sourceEvents: number;
  summarizedEvents: number;
  preservedEvents: number;
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
