import { randomUUID } from "node:crypto";
import type {
  ChatProvider,
  ModelUsageAttribution,
  ModelUsageRecord,
  ModelUsageRequestKind,
  ModelUsageRoute,
  ModelUsageStatus,
  ModelUsageVisibility,
  Session,
  Turn,
  UsageRequestAttribution,
} from "@openpond/contracts";
import { UsageRequestAttributionSchema } from "@openpond/contracts";
import { isOpenAiCompatibleProviderId } from "../openpond/openai-compatible-provider.js";
import { now, textFromUnknown } from "../utils.js";
import { normalizeModelUsageTokens } from "./model-usage-normalization.js";

export type ModelUsageDeltaLike = {
  text?: string;
  reasoningText?: string;
  toolCalls?: readonly unknown[];
  usage?: unknown;
};

export type ModelUsageRecordUpsert = (record: ModelUsageRecord) => Promise<void>;

export function createProviderRequestUsageRecord(input: {
  session: Session;
  turn?: Turn | null;
  provider: ChatProvider;
  model: string;
  requestId: string;
  requestOrdinal: number;
  requestKind?: ModelUsageRequestKind;
  startedAt: string;
  completedAt: string | null;
  firstTokenMs: number | null;
  usage: unknown;
  status: ModelUsageStatus;
  error?: unknown;
}): ModelUsageRecord {
  const tokens = normalizeModelUsageTokens(input.usage);
  const requestKind = input.requestKind ?? modelUsageRequestKind({
    session: input.session,
    turn: input.turn ?? null,
    requestOrdinal: input.requestOrdinal,
  });
  const completedAt = input.completedAt;
  const errorMessage = input.error ? textFromUnknown(input.error) || null : null;
  return {
    id: `usage_${randomUUID()}`,
    requestId: input.requestId,
    requestOrdinal: input.requestOrdinal,
    sessionId: input.session.id,
    turnId: input.turn?.id ?? null,
    provider: input.provider,
    model: input.model || "unknown",
    route: modelUsageRoute(input.provider),
    source: tokens.promptTokens !== null || tokens.completionTokens !== null || tokens.totalTokens !== null
      ? "provider_usage"
      : "missing",
    requestKind,
    visibility: modelUsageVisibility(input.session, requestKind),
    status: input.status,
    startedAt: input.startedAt,
    completedAt,
    durationMs: completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(input.startedAt)) : null,
    firstTokenMs: input.firstTokenMs,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    totalTokens: tokens.totalTokens,
    errorType: input.error ? errorType(input.error) : null,
    errorMessage,
    attribution: modelUsageAttribution({
      session: input.session,
      turn: input.turn ?? null,
      requestKind,
      requestOrdinal: input.requestOrdinal,
    }),
  };
}

export async function startProviderRequestUsageRecorder(input: {
  session: Session;
  turn?: Turn | null;
  provider: ChatProvider;
  model: string;
  requestId: string;
  requestOrdinal: number;
  requestKind?: ModelUsageRequestKind;
  upsert: ModelUsageRecordUpsert;
}): Promise<ProviderRequestUsageRecorder> {
  const recorder = new ProviderRequestUsageRecorder(input);
  await recorder.start();
  return recorder;
}

export class ProviderRequestUsageRecorder {
  private latestUsage: unknown = null;
  private firstTokenMs: number | null = null;
  private readonly startedAt = now();
  private readonly startedAtMs = Date.now();

  constructor(
    private readonly input: {
      session: Session;
      turn?: Turn | null;
      provider: ChatProvider;
      model: string;
      requestId: string;
      requestOrdinal: number;
      requestKind?: ModelUsageRequestKind;
      upsert: ModelUsageRecordUpsert;
    },
  ) {}

  async start(): Promise<void> {
    await this.upsert("started", null);
  }

  observeDelta(delta: ModelUsageDeltaLike): void {
    if (this.firstTokenMs === null && modelUsageDeltaHasOutput(delta)) {
      this.firstTokenMs = Math.max(0, Date.now() - this.startedAtMs);
    }
    if (delta.usage) this.latestUsage = delta.usage;
  }

  async complete(): Promise<void> {
    await this.upsert("completed", now());
  }

  async fail(error: unknown, status: "failed" | "interrupted"): Promise<void> {
    await this.upsert(status, now(), error);
  }

  private async upsert(
    status: ModelUsageStatus,
    completedAt: string | null,
    error?: unknown,
  ): Promise<void> {
    await this.input.upsert(createProviderRequestUsageRecord({
      session: this.input.session,
      turn: this.input.turn,
      provider: this.input.provider,
      model: this.input.model,
      requestId: this.input.requestId,
      requestOrdinal: this.input.requestOrdinal,
      requestKind: this.input.requestKind,
      startedAt: this.startedAt,
      completedAt,
      firstTokenMs: this.firstTokenMs,
      usage: this.latestUsage,
      status,
      error,
    }));
  }
}

export function modelUsageDeltaHasOutput(delta: ModelUsageDeltaLike): boolean {
  return Boolean(
    delta.text ||
    delta.reasoningText ||
    (delta.toolCalls && delta.toolCalls.length > 0),
  );
}

function modelUsageRoute(provider: ChatProvider): ModelUsageRoute {
  if (provider === "openpond") return "openpond_hosted";
  if (provider === "codex") return "codex_app_server";
  if (isOpenAiCompatibleProviderId(provider)) return "local_byok";
  return "unknown";
}

function modelUsageRequestKind(input: {
  session: Session;
  turn: Turn | null;
  requestOrdinal: number;
}): ModelUsageRequestKind {
  if (input.turn && insightsQuestionFromTurn(input.turn)) {
    return "insights_question";
  }
  if ((input.turn && insightRunIdFromTurn(input.turn)) || input.session.systemKind === "openpond.insights") {
    return "insights_scan";
  }
  const requestAttribution = usageRequestAttributionFromTurn(input.turn);
  if (
    requestAttribution?.subagentRunId ||
    requestAttribution?.workflowKind === "subagent"
  ) {
    return "subagent";
  }
  if (
    requestAttribution?.workflowKind === "goal_control" ||
    requestAttribution?.surface === "goal" ||
    requestAttribution?.goalId ||
    (input.turn && goalIdFromTurn(input.turn))
  ) {
    return "goal_control";
  }
  if (input.turn && commandNameFromTurn(input.turn)) return "slash_command";
  return input.requestOrdinal === 0 ? "chat_turn" : "tool_loop";
}

function modelUsageVisibility(
  session: Session,
  requestKind: ModelUsageRequestKind,
): ModelUsageVisibility {
  if (session.systemKind) return "system";
  if (
    requestKind === "context_compaction" ||
    requestKind === "create_improve_planner" ||
    requestKind === "goal_control" ||
    requestKind === "subagent" ||
    requestKind === "insights_scan" ||
    requestKind === "insights_question" ||
    requestKind === "codex_context"
  ) {
    return "background";
  }
  return "user_facing";
}

function modelUsageAttribution(input: {
  session: Session;
  turn: Turn | null;
  requestKind: ModelUsageRequestKind;
  requestOrdinal: number;
}): ModelUsageAttribution {
  const requestAttribution = usageRequestAttributionFromTurn(input.turn);
  const commandName = commandNameFromTurn(input.turn);
  return {
    surface: requestAttribution?.surface ?? usageSurface(input.session, input.requestKind),
    workflowKind: requestAttribution?.workflowKind ?? usageWorkflowKind(input.requestKind, input.requestOrdinal, commandName),
    sessionId: input.session.id,
    turnId: input.turn?.id ?? null,
    insightRunId: requestAttribution?.insightRunId ?? insightRunIdFromTurn(input.turn),
    goalId: requestAttribution?.goalId ?? goalIdFromTurn(input.turn),
    subagentRunId: requestAttribution?.subagentRunId ?? null,
    subagentRoleId: requestAttribution?.subagentRoleId ?? null,
    createImproveRunId: requestAttribution?.createImproveRunId ?? input.turn?.createImproveRun?.id ?? null,
    commandName,
    commandSource: requestAttribution?.commandSource ?? commandSourceFromTurn(input.turn, commandName),
    appId: input.session.appId,
    workspaceKind: input.session.workspaceKind ?? null,
    workspaceId: input.session.workspaceId ?? null,
    localProjectId: input.session.localProjectId ?? null,
    cloudProjectId: input.session.cloudProjectId ?? null,
    sourceEventSequence: insightSourceEventSequenceFromTurn(input.turn),
  };
}

function usageSurface(
  session: Session,
  requestKind: ModelUsageRequestKind,
): ModelUsageAttribution["surface"] {
  if (session.systemKind === "openpond.insights" || requestKind === "insights_scan" || requestKind === "insights_question") {
    return "insights";
  }
  if (requestKind === "create_improve_planner") return "create_improve";
  if (requestKind === "context_compaction") return "compaction";
  if (requestKind === "subagent") return "goal";
  if (requestKind === "goal_control") return "goal";
  return "chat";
}

function usageWorkflowKind(
  requestKind: ModelUsageRequestKind,
  requestOrdinal: number,
  commandName: string | null,
): ModelUsageAttribution["workflowKind"] {
  if (requestKind === "create_improve_planner") return "planner";
  if (requestKind === "context_compaction") return "summary";
  if (requestKind === "insights_scan" || requestKind === "insights_question") return "scan";
  if (requestKind === "subagent") return "subagent";
  if (requestKind === "goal_control") return "goal_control";
  if (commandName || requestKind === "slash_command") return "slash_command";
  return requestOrdinal === 0 ? "direct_chat" : "tool_loop";
}

function usageRequestAttributionFromTurn(turn: Turn | null): UsageRequestAttribution | null {
  if (!turn) return null;
  const parsed = UsageRequestAttributionSchema.safeParse(turn.metadata?.usageAttribution);
  return parsed.success ? parsed.data : null;
}

function commandNameFromTurn(turn: Turn | null): string | null {
  if (!turn) return null;
  const requestAttribution = usageRequestAttributionFromTurn(turn);
  const attributedCommand = requestAttribution?.commandName;
  if (typeof attributedCommand === "string" && attributedCommand.trim()) {
    return attributedCommand.trim();
  }
  const command = turn.createImproveRun?.command;
  return typeof command === "string" && command.trim().startsWith("/")
    ? command.trim()
    : null;
}

function commandSourceFromTurn(
  turn: Turn | null,
  commandName: string | null,
): ModelUsageAttribution["commandSource"] {
  const requestSource = turn?.createImproveRun?.metadata?.source;
  if (requestSource === "native_model_tool") return "model_tool";
  return commandName ? "prompt_parse" : null;
}

function insightRunIdFromTurn(turn: Turn | null): string | null {
  if (!turn) return null;
  const metadata = turn.metadata?.insightsRun;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const id = (metadata as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function insightsQuestionFromTurn(turn: Turn | null): boolean {
  if (!turn) return false;
  const metadata = turn.metadata?.insightsQuestion;
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata));
}

function insightSourceEventSequenceFromTurn(turn: Turn | null): number | null {
  if (!turn) return null;
  const metadata = turn.metadata?.insightsRun;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const sourceEventSequence = (metadata as Record<string, unknown>).sourceEventSequence;
  return Number.isInteger(sourceEventSequence) && Number(sourceEventSequence) >= 0
    ? Number(sourceEventSequence)
    : null;
}

function goalIdFromTurn(turn: Turn | null): string | null {
  if (!turn) return null;
  const metadata = turn.metadata?.threadGoal;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const id = (metadata as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name.trim() : "Error";
}
