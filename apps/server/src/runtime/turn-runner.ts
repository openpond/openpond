import { randomUUID } from "node:crypto";
import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  CreatePipelineSnapshotSchema,
  ResolveApprovalRequestSchema,
  SendTurnRequestSchema,
  UpdateTurnCreatePipelineRequestSchema,
  type Approval,
  type ChatModelRef,
  type ChatProvider,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type SendTurnRequest,
  type OpenPondActionCatalogEntry,
  type OpenPondApp,
  type RuntimeEvent,
  type Session,
  type Turn,
  type WorkspaceDiffSummary,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { HOSTED_CHAT_SYSTEM_PROMPT } from "../constants.js";
import {
  assertCreatePipelineMutationApproved,
  assertCreatePipelineSnapshotLinked,
  isCreatePipelineMutationState,
} from "../create-pipeline-guards.js";
import {
  chatAttachmentContext,
  chatAttachmentSummaries,
  formatPromptWithAttachmentContext,
  materializeChatAttachments,
} from "../chat-attachments.js";
import {
  hostedAutoCompactionDecision,
  runHostedContextCompaction,
  type HostedCompactionProvider,
} from "../openpond/context-compaction.js";
import { buildChatMessagesForProvider } from "../openpond/hosted-chat.js";
import {
  extractWorkspaceToolRequests,
  formatWorkspaceToolValidationErrorForModel,
  formatWorkspaceToolResultForModel,
  validateWorkspaceToolRequest,
} from "../openpond/hosted-tool-protocol.js";
import { isOpenAiCompatibleProviderId } from "../openpond/openai-compatible-provider.js";
import type { RuntimeCodexSession } from "../types.js";
import { event, now } from "../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "./background-worker-queue.js";
import {
  applyApprovedLocalCreatePipelineSnapshot,
  type LocalCreatePipelineCheckInput,
  type LocalCreatePipelineCheckResult,
} from "./local-create-pipeline.js";
import {
  createBlockedCreatePipelinePlannerSnapshot,
  runModelBackedCreatePipelinePlanner,
  type CreatePipelinePlanner,
} from "./create-pipeline-planner.js";
import { requiresWorkspaceToolForPrompt } from "./workspace-tool-requirements.js";

type HostedToolLoopDelta = {
  text?: string;
  raw?: unknown;
  usage?: unknown;
};

type HostedMessages = ReturnType<typeof buildChatMessagesForProvider>;
type CodexTurnInput = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "model" | "codexPermissionMode" | "codexReasoningEffort"
>;
type ActiveTurn = {
  session: Session;
  turn: Turn;
  controller: AbortController;
  codexRuntime?: RuntimeCodexSession;
  codexTurnId?: string;
};

export function createTurnRunner(deps: {
  attachmentRootDir: string;
  store: {
    snapshot(): Promise<{ events: RuntimeEvent[]; turns: Turn[]; approvals?: Approval[] }>;
    getTurn(turnId: string): Promise<Turn | null>;
    insertTurn(turn: Turn): Promise<void>;
    updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null>;
    getApproval(approvalId: string): Promise<Approval | null>;
  };
  upsertApproval: (approval: Approval) => Promise<void>;
  getSession: (sessionId: string) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  completeTurn: (sessionId: string, turnId: string, providerTurnId?: string | null) => Promise<Turn>;
  failTurn: (session: Session, turnId: string, message: string) => Promise<Turn>;
  interruptTurn: (session: Session, turnId: string, message?: string) => Promise<Turn>;
  defaultSessionCwd: (appId?: string | null) => string;
  findOpenPondApp: (appId: string) => Promise<OpenPondApp>;
  resolveSessionWorkspaceCwd: (
    session: Pick<Session, "appId" | "cwd" | "workspaceId" | "workspaceKind">,
    options?: { ensureOpenPond?: boolean }
  ) => Promise<string | null>;
  ensureCodexRuntime: (
    session: Session,
    turnInput: CodexTurnInput
  ) => Promise<RuntimeCodexSession>;
  appendWorkspaceDiffEvent: (
    session: Session,
    turnId: string,
    options?: { baseline?: WorkspaceDiffSummary | null }
  ) => Promise<void>;
  workspaceDiffBaseline: (session: Session) => Promise<WorkspaceDiffSummary | null>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null }
  ) => Promise<WorkspaceToolResult>;
  loadPersonalizationSoul: () => Promise<string>;
  maybeCreateScaffoldForTurn: (session: Session, turnId: string, prompt: string) => Promise<Session>;
  hostedSystemPrompt: (
    basePrompt: string,
    personalizationSoul: string,
    session: Session,
    options?: { mentionedApps?: OpenPondApp[]; openPondActionCatalog?: OpenPondActionCatalogEntry[] }
  ) => Promise<string>;
  appendAssistantText: (session: Session, turnId: string, text: string) => Promise<void>;
  appendHostedContextUsage: (input: {
    session: Session;
    turnId: string;
    provider: "openpond";
    model: string;
    messages: HostedMessages;
    usage?: unknown;
    includeCompletion?: boolean;
  }) => Promise<void>;
  streamLocalByokChatTurn?: (input: {
    providerId: ChatProvider;
    modelId?: string | null;
    messages: HostedMessages;
    requestId: string;
    signal: AbortSignal;
  }) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  runLocalCreatePipelineChecks?: (
    input: LocalCreatePipelineCheckInput,
  ) => Promise<LocalCreatePipelineCheckResult>;
  planCreatePipeline?: CreatePipelinePlanner;
  turnFollowUpQueue: BackgroundWorkerQueue;
  maxHostedWorkspaceToolRounds: number;
  maxRepeatedInvalidToolRequests: number;
}) {
  const {
    attachmentRootDir,
    store,
    upsertApproval,
    getSession,
    updateSession,
    completeTurn,
    failTurn,
    interruptTurn,
    defaultSessionCwd,
    findOpenPondApp,
    resolveSessionWorkspaceCwd,
    ensureCodexRuntime,
    appendWorkspaceDiffEvent,
    workspaceDiffBaseline,
    appendRuntimeEvent,
    executeWorkspaceTool,
    loadPersonalizationSoul,
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
    streamLocalByokChatTurn,
    runLocalCreatePipelineChecks,
    planCreatePipeline,
    turnFollowUpQueue,
    maxHostedWorkspaceToolRounds,
    maxRepeatedInvalidToolRequests,
  } = deps;
  const activeTurns = new Map<string, ActiveTurn>();
  const createPipelineApplyJobs = new Map<string, BackgroundWorkReceipt>();

  function interruptedError(): Error {
    const error = new Error("Stopped by user");
    error.name = "AbortError";
    return error;
  }

  function throwIfInterrupted(signal: AbortSignal): void {
    if (signal.aborted) throw interruptedError();
  }

  function waitForInterrupt(signal: AbortSignal): Promise<never> {
    if (signal.aborted) return Promise.reject(interruptedError());
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(interruptedError()), { once: true });
    });
  }

  async function getStoredTurn(turnId: string): Promise<Turn | null> {
    return store.getTurn(turnId);
  }

  async function insertStoredTurn(turn: Turn): Promise<void> {
    await store.insertTurn(turn);
  }

  async function updateStoredTurn(
    turnId: string,
    updater: (turn: Turn) => Turn,
  ): Promise<Turn | null> {
    return store.updateTurn(turnId, updater);
  }

  async function runHostedToolLoop(params: {
    session: Session;
    turn: Turn;
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    mentionedApps: OpenPondApp[];
    userPrompt: string;
    workspaceDiffBaseline: WorkspaceDiffSummary | null;
    signal: AbortSignal;
    stream: (messages: HostedMessages) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  }): Promise<Session> {
    let session = params.session;
    const messages = [...params.messages];
    const invalidRequestCounts = new Map<string, number>();
    let workspaceToolResultCount = 0;
    let toolRequiredCorrectionSent = false;
    for (let index = 0; index < maxHostedWorkspaceToolRounds; index += 1) {
      throwIfInterrupted(params.signal);
      if (params.provider === "openpond") {
        await appendHostedContextUsage({
          session,
          turnId: params.turn.id,
          provider: params.provider,
          model: params.model,
          messages,
        });
      }
      let assistantText = "";
      let latestUsage: unknown;
      for await (const delta of params.stream(messages)) {
        throwIfInterrupted(params.signal);
        if (delta.usage) latestUsage = delta.usage;
        if (delta.text) assistantText += delta.text;
      }

      const assistantMessage = {
        role: "assistant" as const,
        content: assistantText.trim() || "Requesting workspace tool execution.",
      };
      const requests = extractWorkspaceToolRequests(assistantText);
      if (requests.length === 0) {
        if (
          workspaceToolResultCount === 0 &&
          !toolRequiredCorrectionSent &&
          requiresWorkspaceToolForPrompt(session, params.userPrompt)
        ) {
          messages.push(assistantMessage);
          if (params.provider === "openpond") {
            await appendHostedContextUsage({
              session,
              turnId: params.turn.id,
              provider: params.provider,
              model: params.model,
              messages,
              usage: latestUsage,
              includeCompletion: true,
            });
          }
          messages.push({
            role: "user",
            content: [
              "Your previous response did not call a workspace tool.",
              "The user's request appears to require inspecting or changing the active workspace.",
              "Call the appropriate openpond_tool block now. Do not claim the workspace changed until a tool result confirms it.",
              "If the request cannot be completed with workspace tools, explain the blocker instead of saying it is done.",
            ].join(" "),
          });
          toolRequiredCorrectionSent = true;
          continue;
        }
        await appendAssistantText(session, params.turn.id, assistantText);
        if (params.provider === "openpond") {
          await appendHostedContextUsage({
            session,
            turnId: params.turn.id,
            provider: params.provider,
            model: params.model,
            messages: [...messages, assistantMessage],
            usage: latestUsage,
            includeCompletion: true,
          });
        }
        return session;
      }

      messages.push(assistantMessage);
      if (params.provider === "openpond") {
        await appendHostedContextUsage({
          session,
          turnId: params.turn.id,
          provider: params.provider,
          model: params.model,
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
      }

      const toolResults: string[] = [];
      for (const request of requests) {
        throwIfInterrupted(params.signal);
        const toolRequest = normalizeMentionedSandboxToolRequest({
          request: {
            ...request,
            source: "chat_action" as const,
          },
          mentionedApps: params.mentionedApps,
          userPrompt: params.userPrompt,
        });
        const validationIssues = validateWorkspaceToolRequest(toolRequest);
        if (validationIssues.length > 0) {
          const key = `${toolRequest.action}:${validationIssues.map((issue) => `${issue.path}:${issue.expected}`).join("|")}`;
          const count = (invalidRequestCounts.get(key) ?? 0) + 1;
          invalidRequestCounts.set(key, count);
          if (count >= maxRepeatedInvalidToolRequests) {
            throw new Error(
              `Hosted workspace tool produced repeated invalid ${toolRequest.action} requests: ${validationIssues
                .map((issue) => `${issue.path} expected ${issue.expected}`)
                .join("; ")}`
            );
          }
          toolResults.push(formatWorkspaceToolValidationErrorForModel(toolRequest, validationIssues));
          continue;
        }
        const result = await executeWorkspaceTool(
          session.id,
          toolRequest,
          { turnId: params.turn.id, workspaceDiffBaseline: params.workspaceDiffBaseline }
        );
        workspaceToolResultCount += 1;
        session = await getSession(session.id);
        toolResults.push(formatWorkspaceToolResultForModel(result));
      }

      messages.push({
        role: "user",
        content: [
          "Workspace tool result:",
          toolResults.join("\n\n"),
          "Continue. If another workspace action is required, respond with exactly one openpond_tool block. Otherwise answer the user normally without tool JSON.",
        ].join("\n\n"),
      });
    }

    const limitLabel = Number.isFinite(maxHostedWorkspaceToolRounds)
      ? `${maxHostedWorkspaceToolRounds}`
      : "configured";
    await appendAssistantText(
      session,
      params.turn.id,
      [
        `I hit the hosted workspace tool iteration limit (${limitLabel}) before I could finish.`,
        "Please send the request again or narrow the workspace target so I can continue from the current context.",
      ].join(" ")
    );
    return session;
  }

  async function maybeAutoCompactHostedContext(params: {
    session: Session;
    turn: Turn;
    provider: HostedCompactionProvider;
    model: string;
    priorEvents: RuntimeEvent[];
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
  }): Promise<RuntimeEvent[]> {
    throwIfInterrupted(params.signal);
    const projectedMessages = buildChatMessagesForProvider(params.priorEvents, params.prompt, params.systemPrompt);
    const decision = hostedAutoCompactionDecision({
      provider: params.provider,
      model: params.model,
      messages: projectedMessages,
    });
    if (!decision.shouldCompact || params.priorEvents.length === 0) return params.priorEvents;

    const startedEvent = event({
      sessionId: params.session.id,
      turnId: params.turn.id,
      name: "session.compaction.started",
      source: "server",
      appId: params.session.appId,
      status: "started",
      output: "Auto compacting conversation context",
      data: {
        version: 1,
        provider: params.provider,
        model: params.model,
        reason: "auto",
        projectedTokens: decision.projectedTokens,
        thresholdTokens: decision.thresholdTokens,
        usableContextTokens: decision.usableContextTokens,
        maxContextTokens: decision.maxContextTokens,
        tokenSource: decision.tokenSource,
      },
    });
    await appendRuntimeEvent(startedEvent);

    try {
      const result = await runHostedContextCompaction({
        session: params.session,
        events: params.priorEvents,
        provider: params.provider,
        model: params.model,
        signal: params.signal,
      });
      throwIfInterrupted(params.signal);
      const completedEvent = event({
        sessionId: params.session.id,
        turnId: params.turn.id,
        name: "session.compaction.completed",
        source: "server",
        appId: params.session.appId,
        status: "completed",
        output: "Auto compacted conversation context",
        data: {
          version: 1,
          provider: params.provider,
          model: result.model,
          reason: "auto",
          mode: "summary",
          summary: result.summary,
          compactedThroughEventId: result.compactedThroughEventId,
          compactedThroughTurnId: result.compactedThroughTurnId,
          preservedFromEventId: result.preservedFromEventId,
          sourceEventCount: result.sourceEventCount,
          preservedEventCount: result.preservedEventCount,
          inputTokensBefore: result.inputTokensBefore,
          inputTokensAfter: result.inputTokensAfter,
          maxContextTokens: result.maxContextTokens,
          tokenSource: result.tokenSource,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
        },
      });
      await appendRuntimeEvent(completedEvent);
      return [...params.priorEvents, startedEvent, completedEvent];
    } catch (error) {
      if (params.signal.aborted) throw interruptedError();
      const message = error instanceof Error ? error.message : String(error);
      const failedEvent = event({
        sessionId: params.session.id,
        turnId: params.turn.id,
        name: "session.compaction.failed",
        source: "server",
        appId: params.session.appId,
        status: "failed",
        output: "Auto context compaction failed",
        error: message,
        data: {
          version: 1,
          provider: params.provider,
          model: params.model,
          reason: "auto",
          error: message,
          projectedTokens: decision.projectedTokens,
          thresholdTokens: decision.thresholdTokens,
          usableContextTokens: decision.usableContextTokens,
          maxContextTokens: decision.maxContextTokens,
          tokenSource: decision.tokenSource,
        },
      });
      await appendRuntimeEvent(failedEvent);
      return [...params.priorEvents, startedEvent, failedEvent];
    }
  }

  async function interruptSessionTurn(sessionId: string): Promise<Turn> {
    const active = activeTurns.get(sessionId);
    const session = active?.session ?? (await getSession(sessionId));
    const inProgressTurn = active?.turn ?? (await findInProgressTurn(sessionId));
    if (!inProgressTurn) throw new Error("No active turn to stop.");

    active?.controller.abort();
    if (active?.codexRuntime && active.codexTurnId) {
      try {
        await active.codexRuntime.client.interruptTurn({
          threadId: active.codexRuntime.threadId,
          turnId: active.codexTurnId,
        });
      } catch {
        await active.codexRuntime.client.stop().catch(() => undefined);
      }
    }
    return interruptTurn(session, inProgressTurn.id, "Stopped by user");
  }

  async function findInProgressTurn(sessionId: string): Promise<Turn | null> {
    const snapshot = await store.snapshot();
    for (let index = snapshot.turns.length - 1; index >= 0; index -= 1) {
      const turn = snapshot.turns[index]!;
      if (turn.sessionId === sessionId && turn.status === "in_progress") return turn;
    }
    return null;
  }

  async function turnWasInterrupted(turnId: string): Promise<boolean> {
    return (await store.snapshot()).turns.some((candidate) => candidate.id === turnId && candidate.status === "interrupted");
  }

  async function activeInProgressTurn(sessionId: string): Promise<Turn | null> {
    const active = activeTurns.get(sessionId);
    if (!active) return null;
    const stored = await getStoredTurn(active.turn.id);
    if (!stored || stored.status === "in_progress") return active.turn;
    return null;
  }

  async function mentionedAppsForTurn(appIds: string[] | undefined): Promise<OpenPondApp[]> {
    const uniqueIds = Array.from(new Set((appIds ?? []).map((appId) => appId.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    const apps = await Promise.all(
      uniqueIds.map((appId) =>
        findOpenPondApp(appId).catch(() => null)
      )
    );
    return apps.filter((app): app is OpenPondApp => Boolean(app));
  }

  async function sendTurn(sessionId: string, payload: unknown): Promise<Turn> {
    const input = SendTurnRequestSchema.parse(payload);
    const existingTurn = (await activeInProgressTurn(sessionId)) ?? (await findInProgressTurn(sessionId));
    if (existingTurn) {
      throw new Error("A turn is already running for this chat.");
    }
    let session = await getSession(sessionId);
    const activeProvider = input.modelRef?.providerId ?? session.modelRef?.providerId ?? session.provider;
    const activeModelId = input.modelRef?.modelId ?? input.model ?? session.modelRef?.modelId ?? null;
    const turnModelRef: ChatModelRef | null = activeModelId
      ? { providerId: activeProvider, modelId: activeModelId }
      : input.modelRef ?? session.modelRef ?? null;
    const priorEvents = (await store.snapshot()).events.filter((item) => item.sessionId === sessionId);

    const startedAt = now();
    const createPipelineMetadata = {
      ...(input.metadata ? input.metadata : {}),
      ...(input.createPipelineRequest ? { createPipelineRequest: input.createPipelineRequest } : {}),
      ...(input.createPipeline ? { createPipeline: input.createPipeline } : {}),
    };
    const turn: Turn = {
      id: randomUUID(),
      sessionId,
      providerTurnId: null,
      modelRef: turnModelRef,
      prompt: input.prompt,
      startedAt,
      completedAt: null,
      status: "in_progress",
      error: null,
      metadata: createPipelineMetadata,
      createPipelineRequest: input.createPipelineRequest ?? null,
      createPipeline: input.createPipeline ?? null,
    };
    await insertStoredTurn(turn);
    const initialCwd =
      input.cwd ??
      (await resolveSessionWorkspaceCwd(session, { ensureOpenPond: false })) ??
      session.cwd ??
      defaultSessionCwd(session.appId);
    session = await updateSession(sessionId, {
      provider: activeProvider,
      modelRef: turnModelRef,
      status: "active",
      title: session.title === "New chat" ? input.prompt.slice(0, 64) : session.title,
      cwd: initialCwd,
    });
    const controller = new AbortController();
    const activeTurn: ActiveTurn = { session, turn, controller };
    activeTurns.set(sessionId, activeTurn);

    try {
      const attachmentContexts = await materializeChatAttachments({
        attachmentRootDir,
        sessionId,
        turnId: turn.id,
        attachments: input.attachments,
      });
      const attachmentContext = chatAttachmentContext(attachmentContexts);
      const providerPrompt = formatPromptWithAttachmentContext(input.prompt, attachmentContext);
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: turn.id,
          name: "turn.started",
          source: "chat_action",
          appId: session.appId,
          args: {
            prompt: input.prompt,
            cwd: initialCwd,
            provider: activeProvider,
            ...(turnModelRef ? { modelRef: turnModelRef } : {}),
            ...createPipelineMetadata,
            ...(attachmentContexts.length > 0
              ? {
                  attachments: chatAttachmentSummaries(input.attachments, {
                    sessionId,
                    turnId: turn.id,
                    materialized: attachmentContexts,
                  }),
                  attachmentContext,
                }
              : {}),
          },
          status: "started",
        })
      );
      const threadGoal = threadGoalFromTurnMetadata(input.metadata);
      if (threadGoal) {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: threadGoal.output,
            data: threadGoal.data,
          })
        );
      }
      if (input.createPipelineRequest) {
        let effectiveCreatePipeline = input.createPipeline ?? null;
        let plannedByServer = false;
        if (!effectiveCreatePipeline) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "create_pipeline.updated",
              source: "server",
              appId: session.appId,
              status: "pending",
              output: "Create planner is preparing the plan.",
              data: {
                createPipelineRequest: input.createPipelineRequest,
                createPipeline: null,
              },
            })
          );
          effectiveCreatePipeline = await planCreatePipelineForTurn({
            session,
            turn,
            request: input.createPipelineRequest,
            previousSnapshot: null,
            signal: controller.signal,
          });
          plannedByServer = true;
          await persistCreatePipelineSnapshot({
            session,
            turnId: turn.id,
            request: input.createPipelineRequest,
            snapshot: effectiveCreatePipeline,
            source: "server",
          });
        } else {
          assertCreatePipelineSnapshotLinked({
            actionLabel: "Create pipeline send turn",
            request: input.createPipelineRequest,
            snapshot: effectiveCreatePipeline,
          });
        }
        const createPipelineState = effectiveCreatePipeline.state;
        if (!plannedByServer) {
          await appendRuntimeEvent(
            event({
              sessionId,
              turnId: turn.id,
              name: "create_pipeline.updated",
              source: "server",
              appId: session.appId,
              status: createPipelineRuntimeEventStatus(effectiveCreatePipeline),
              output: createPipelineState === "awaiting_questions"
                ? "Create question ready."
                : "Create plan ready for review.",
              data: {
                createPipelineRequest: input.createPipelineRequest,
                createPipeline: effectiveCreatePipeline,
              },
            })
          );
          await syncCreatePlanApproval({
            session,
            turn,
            request: input.createPipelineRequest,
            snapshot: effectiveCreatePipeline,
          });
        }
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "turn.completed",
            source: "server",
            appId: session.appId,
            status: "completed",
            output: createPipelineState === "awaiting_questions"
              ? "Create pipeline paused for questions."
              : "Create pipeline paused for plan review.",
          })
        );
        return completeTurn(sessionId, turn.id, null);
      }
      const initialWorkspaceDiff = await workspaceDiffBaseline(session);
      const mentionedApps = await mentionedAppsForTurn(input.mentionedAppIds);
      session = await maybeCreateScaffoldForTurn(session, turn.id, providerPrompt);
      activeTurn.session = session;
      throwIfInterrupted(controller.signal);
      const personalizationSoul = await loadPersonalizationSoul();
      if (session.provider === "openpond") {
        const providerTurnId = `openpond-${turn.id}`;
        const model = turnModelRef?.modelId || input.model || DEFAULT_OPENPOND_CHAT_MODEL;
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
          mentionedApps,
          openPondActionCatalog: input.openPondActionCatalog,
        });
        const hostedPriorEvents = await maybeAutoCompactHostedContext({
          session,
          turn,
          provider: "openpond",
          model,
          priorEvents,
          prompt: providerPrompt,
          systemPrompt,
          signal: controller.signal,
        });
        const messages = buildChatMessagesForProvider(hostedPriorEvents, providerPrompt, systemPrompt);
        session = await runHostedToolLoop({
          session,
          turn,
          provider: "openpond",
          model,
          messages,
          mentionedApps,
          userPrompt: providerPrompt,
          workspaceDiffBaseline: initialWorkspaceDiff,
          signal: controller.signal,
          stream: async function* (loopMessages) {
            for await (const delta of streamOpenPondHostedChatTurn({
              model,
              messages: loopMessages,
              requestId: turn.id,
              signal: controller.signal,
            })) {
              if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
            }
          },
        });
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "turn.completed",
            source: "provider",
            appId: session.appId,
            status: "completed",
          })
        );
        return completeTurn(sessionId, turn.id, providerTurnId);
      }

      if (isOpenAiCompatibleProviderId(session.provider)) {
        const providerTurnId = `${session.provider}-${turn.id}`;
        const model = turnModelRef?.modelId ?? input.model ?? null;
        await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId }));
        const systemPrompt = await hostedSystemPrompt(HOSTED_CHAT_SYSTEM_PROMPT, personalizationSoul, session, {
          mentionedApps,
          openPondActionCatalog: input.openPondActionCatalog,
        });
        const messages = buildChatMessagesForProvider(priorEvents, providerPrompt, systemPrompt);
        session = await runHostedToolLoop({
          session,
          turn,
          provider: session.provider,
          model: model ?? "default",
          messages,
          mentionedApps,
          userPrompt: providerPrompt,
          workspaceDiffBaseline: initialWorkspaceDiff,
          signal: controller.signal,
          stream: async function* (loopMessages) {
            if (!streamLocalByokChatTurn) {
              throw new Error(`Provider ${session.provider} is not configured for local BYOK chat.`);
            }
            for await (const delta of streamLocalByokChatTurn({
              providerId: session.provider,
              modelId: model,
              messages: loopMessages,
              requestId: turn.id,
              signal: controller.signal,
            })) {
              if (delta.text) yield { text: delta.text, raw: delta.raw };
              if (delta.usage) yield { raw: delta.raw, usage: delta.usage };
            }
          },
        });
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: turn.id,
            name: "turn.completed",
            source: "provider",
            appId: session.appId,
            status: "completed",
            data: {
              provider: session.provider,
              model,
            },
          })
        );
        return completeTurn(sessionId, turn.id, providerTurnId);
      }

      if (session.provider !== "codex") throw new Error(`Unsupported provider: ${session.provider}`);
      const codexModel = turnModelRef?.modelId ?? input.model ?? null;
      const turnCwd =
        input.cwd ??
        (await resolveSessionWorkspaceCwd(session, {
          ensureOpenPond: session.workspaceKind !== "local_project",
        })) ??
        session.cwd;
      if (turnCwd && turnCwd !== session.cwd) session = await updateSession(session.id, { cwd: turnCwd });
      activeTurn.session = session;
      const runtime = await ensureCodexRuntime(session, {
        ...input,
        model: codexModel,
      });
      activeTurn.codexRuntime = runtime;
      throwIfInterrupted(controller.signal);
      const providerTurn = await runtime.client.startTurn({
        threadId: runtime.threadId,
        prompt: providerPrompt,
        cwd: turnCwd ?? session.cwd,
        model: codexModel,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
      });
      activeTurn.codexTurnId = providerTurn.turnId;
      if (controller.signal.aborted) {
        await runtime.client
          .interruptTurn({ threadId: runtime.threadId, turnId: providerTurn.turnId })
          .catch(() => undefined);
        throw interruptedError();
      }
      await updateStoredTurn(turn.id, (current) => ({ ...current, providerTurnId: providerTurn.turnId }));
      await Promise.race([runtime.client.waitForTurn(providerTurn.turnId), waitForInterrupt(controller.signal)]);
      await appendWorkspaceDiffEvent(session, turn.id, { baseline: initialWorkspaceDiff });
      return completeTurn(sessionId, turn.id, providerTurn.turnId);
    } catch (error) {
      if (controller.signal.aborted || (await turnWasInterrupted(turn.id))) {
        return interruptTurn(session, turn.id, "Stopped by user");
      }
      const message = error instanceof Error ? error.message : String(error);
      if (input.createPipelineRequest) {
        await persistCreatePipelinePlanningFailure({
          session,
          turn,
          request: input.createPipelineRequest,
          message,
        }).catch(() => undefined);
      }
      return failTurn(session, turn.id, message);
    } finally {
      if (activeTurns.get(sessionId)?.turn.id === turn.id) activeTurns.delete(sessionId);
    }
  }

  async function updateTurnCreatePipeline(
    sessionId: string,
    turnId: string,
    payload: unknown,
  ): Promise<Turn> {
    const input = UpdateTurnCreatePipelineRequestSchema.parse(payload);
    const session = await getSession(sessionId);
    const requestedCreatePipelineRequest =
      input.createPipelineRequest ?? input.createPipeline.request ?? null;
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Create pipeline turn update",
      request: requestedCreatePipelineRequest,
      snapshot: input.createPipeline,
    });
    const existingTurn = await getStoredTurn(turnId);
    if (!existingTurn || existingTurn.sessionId !== sessionId) throw new Error("Turn not found");
    let nextCreatePipeline = input.createPipeline;
    if (shouldRunCreatePipelinePlanner(nextCreatePipeline)) {
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId,
          name: "create_pipeline.updated",
          source: "server",
          appId: session.appId,
          status: "pending",
          output: "Create planner is preparing the plan.",
          data: {
            createPipelineRequest: requestedCreatePipelineRequest,
            createPipeline: nextCreatePipeline,
          },
        })
      );
      nextCreatePipeline = await planCreatePipelineForTurn({
        session,
        turn: existingTurn,
        request: requestedCreatePipelineRequest ?? nextCreatePipeline.request,
        previousSnapshot: nextCreatePipeline,
        signal: new AbortController().signal,
      });
    }
    let shouldQueueLocalCreateApply = false;
    if (isCreatePipelineMutationState(nextCreatePipeline.state)) {
      assertCreatePipelineMutationApproved({
        actionLabel: "Create pipeline turn update",
        request: requestedCreatePipelineRequest,
        snapshot: nextCreatePipeline,
      });
      shouldQueueLocalCreateApply = shouldApplyLocalCreatePipelineAsync(nextCreatePipeline);
    }
    const result = await updateStoredTurn(turnId, (current) => {
      if (current.sessionId !== sessionId) throw new Error("Turn not found");
      const existingRequest = current.createPipelineRequest;
      if (
        existingRequest?.id &&
        requestedCreatePipelineRequest?.id &&
        existingRequest.id !== requestedCreatePipelineRequest.id
      ) {
        throw new Error("Create pipeline turn update cannot change the original request.");
      }
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          createPipelineRequest: requestedCreatePipelineRequest,
          createPipeline: nextCreatePipeline,
        },
        createPipelineRequest: requestedCreatePipelineRequest,
        createPipeline: nextCreatePipeline,
      };
    });
    if (!result) throw new Error("Turn not found");
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId,
        name: "create_pipeline.updated",
        source: "ui_button",
        appId: session.appId,
        status: createPipelineRuntimeEventStatus(nextCreatePipeline),
        output: nextCreatePipeline.blockedReason ?? nextCreatePipeline.plan?.summary ?? nextCreatePipeline.state,
        data: {
          createPipelineRequest: result.createPipelineRequest,
          createPipeline: result.createPipeline,
        },
      })
    );
    await syncCreatePlanApproval({
      session,
      turn: result,
      request: result.createPipelineRequest ?? requestedCreatePipelineRequest,
      snapshot: result.createPipeline,
    });
    if (shouldQueueLocalCreateApply && result.createPipeline) {
      queueLocalCreatePipelineApply({
        session,
        turn: result,
        request: result.createPipelineRequest ?? requestedCreatePipelineRequest,
        snapshot: result.createPipeline,
      });
    }
    return result;
  }

  async function syncCreatePlanApproval(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot?: CreatePipelineSnapshot | null;
  }): Promise<Approval | null> {
    const snapshot = input.snapshot;
    const plan = snapshot?.plan ?? null;
    if (!snapshot || !plan?.approvalId) return null;
    const status = approvalStatusForPlan(plan.status);
    const existing = await findApproval(plan.approvalId);
    const approval = createPlanApproval({
      existing,
      session: input.session,
      turn: input.turn,
      request: input.request ?? snapshot.request,
      snapshot,
      status,
    });
    await upsertApproval(approval);
    if (!existing && approval.status === "pending") {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turn.id,
          name: "approval.requested",
          source: "server",
          action: "create_plan",
          appId: input.session.appId,
          status: "pending",
          output: approval.title,
          data: approval,
        }),
      );
    }
    if (existing?.status === "pending" && approval.status !== "pending") {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turn.id,
          name: "approval.resolved",
          source: "server",
          action: "create_plan",
          appId: input.session.appId,
          status: approval.status === "accepted" || approval.status === "accepted_for_session" ? "completed" : "failed",
          output: approval.title,
          data: {
            approvalId: approval.id,
            status: approval.status,
          },
        }),
      );
    }
    return approval;
  }

  async function resolveCreatePipelineApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval | null> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const approval = await store.getApproval(approvalId);
    if (!approval || approval.kind !== "create_plan") return null;
    if (approval.status !== "pending") throw new Error("Approval not found or already resolved");
    const turn = approval.turnId ? await getStoredTurn(approval.turnId) : null;
    if (!turn?.createPipeline) {
      throw new Error("Create plan approval is missing its create pipeline turn.");
    }
    const session = await getSession(approval.sessionId);
    const nextSnapshot = createPlanDecisionSnapshot(turn.createPipeline, input.decision);
    const shouldQueueLocalCreateApply = shouldApplyLocalCreatePipelineAsync(nextSnapshot);
    const effectiveSnapshot = nextSnapshot;
    const result = await updateStoredTurn(turn.id, (current) => {
      if (current.sessionId !== approval.sessionId) throw new Error("Turn not found");
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          createPipelineRequest: current.createPipelineRequest ?? effectiveSnapshot.request,
          createPipeline: effectiveSnapshot,
        },
        createPipelineRequest: current.createPipelineRequest ?? effectiveSnapshot.request,
        createPipeline: effectiveSnapshot,
      };
    });
    if (!result) throw new Error("Turn not found");
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Create plan approval resolution",
      request: result.createPipelineRequest ?? effectiveSnapshot.request,
      snapshot: effectiveSnapshot,
    });
    if (isCreatePipelineMutationState(effectiveSnapshot.state)) {
      assertCreatePipelineMutationApproved({
        actionLabel: "Create plan approval resolution",
        request: result.createPipelineRequest ?? effectiveSnapshot.request,
        snapshot: effectiveSnapshot,
      });
    }
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: result.id,
        name: "create_pipeline.updated",
        source: "ui_button",
        appId: session.appId,
        status: createPipelineRuntimeEventStatus(effectiveSnapshot),
        output: effectiveSnapshot.blockedReason ?? effectiveSnapshot.plan?.summary ?? effectiveSnapshot.state,
        data: {
          createPipelineRequest: result.createPipelineRequest,
          createPipeline: effectiveSnapshot,
        },
      }),
    );
    const resolved = await syncCreatePlanApproval({
      session,
      turn: result,
      request: result.createPipelineRequest ?? effectiveSnapshot.request,
      snapshot: effectiveSnapshot,
    });
    if (shouldQueueLocalCreateApply) {
      queueLocalCreatePipelineApply({
        session,
        turn: result,
        request: result.createPipelineRequest ?? effectiveSnapshot.request,
        snapshot: effectiveSnapshot,
      });
    }
    return resolved;
  }

  function shouldApplyLocalCreatePipelineAsync(snapshot: CreatePipelineSnapshot): boolean {
    return Boolean(
      snapshot.state === "applying_source" &&
        snapshot.plan?.status === "approved" &&
        snapshot.request.adapter.kind === "local",
    );
  }

  function queueLocalCreatePipelineApply(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
  }): void {
    const key = `${input.session.id}:${input.turn.id}:${input.snapshot.id}`;
    if (createPipelineApplyJobs.has(key)) return;
    const receipt = turnFollowUpQueue.enqueue(
      {
        label: "Apply approved local Create pipeline",
        metadata: {
          key,
          sessionId: input.session.id,
          turnId: input.turn.id,
          pipelineId: input.snapshot.id,
        },
      },
      async () => {
        try {
          await runQueuedLocalCreatePipelineApply(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const blocked = createPipelineBackgroundFailureSnapshot(input.snapshot, message);
          await persistCreatePipelineSnapshot({
            session: input.session,
            turnId: input.turn.id,
            request: input.request ?? input.snapshot.request,
            snapshot: blocked,
            source: "server",
          });
        } finally {
          createPipelineApplyJobs.delete(key);
        }
      },
    );
    createPipelineApplyJobs.set(key, receipt);
  }

  async function runQueuedLocalCreatePipelineApply(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
  }): Promise<void> {
    const latestTurn = await getStoredTurn(input.turn.id) ?? input.turn;
    const effectiveSnapshot = await applyApprovedLocalCreatePipelineSnapshot(input.snapshot, {
      session: input.session,
      turn: latestTurn,
      ensureCodexRuntime,
      appendRuntimeEvent,
      setProviderTurnId: (providerTurnId) =>
        setTurnProviderTurnId(input.session.id, input.turn.id, providerTurnId),
      onSnapshot: async (snapshot) => {
        await persistCreatePipelineSnapshot({
          session: input.session,
          turnId: input.turn.id,
          request: input.request ?? snapshot.request,
          snapshot,
          source: "server",
        });
      },
      model: input.session.provider === "codex" ? input.session.modelRef?.modelId ?? null : null,
      runChecks: runLocalCreatePipelineChecks,
    });
    await persistCreatePipelineSnapshot({
      session: input.session,
      turnId: input.turn.id,
      request: input.request ?? effectiveSnapshot.request,
      snapshot: effectiveSnapshot,
      source: "server",
    });
  }

  async function planCreatePipelineForTurn(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    previousSnapshot?: CreatePipelineSnapshot | null;
    signal: AbortSignal;
  }): Promise<CreatePipelineSnapshot> {
    if (planCreatePipeline) {
      return planCreatePipeline({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        modelRef: input.turn.modelRef,
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
      });
    }
    const providerId = input.turn.modelRef?.providerId ?? input.session.provider;
    const modelId =
      input.turn.modelRef?.modelId ??
      (providerId === "openpond" ? DEFAULT_OPENPOND_CHAT_MODEL : null);
    if (providerId === "openpond") {
      const model = modelId || DEFAULT_OPENPOND_CHAT_MODEL;
      return runModelBackedCreatePipelinePlanner({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        modelRef: { providerId, modelId: model },
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
        stream: async function* (messages) {
          for await (const delta of streamOpenPondHostedChatTurn({
            model,
            messages,
            requestId: `${input.turn.id}:create-planner`,
            signal: input.signal,
          })) {
            if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
            if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
          }
        },
      });
    }
    if (isOpenAiCompatibleProviderId(providerId) && streamLocalByokChatTurn) {
      if (!modelId) {
        throw new Error(`Create planner requires a selected model for provider ${providerId}.`);
      }
      return runModelBackedCreatePipelinePlanner({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        modelRef: { providerId, modelId },
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
        stream: (messages) =>
          streamLocalByokChatTurn({
            providerId,
            modelId,
            messages,
            requestId: `${input.turn.id}:create-planner`,
            signal: input.signal,
          }),
      });
    }
    throw new Error("Create planner requires OpenPond Chat or a configured OpenAI-compatible provider.");
  }

  async function persistCreatePipelinePlanningFailure(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    message: string;
  }): Promise<Turn | null> {
    const current = await getStoredTurn(input.turn.id);
    const existingSnapshot = current?.createPipeline ?? input.turn.createPipeline ?? null;
    if (existingSnapshot && existingSnapshot.state !== "planning") return current;
    const snapshot = createBlockedCreatePipelinePlannerSnapshot({
      request: input.request,
      previousSnapshot: existingSnapshot,
      modelRef: current?.modelRef ?? input.turn.modelRef,
      reason: `Create planner failed: ${input.message}`,
    });
    return persistCreatePipelineSnapshot({
      session: input.session,
      turnId: input.turn.id,
      request: input.request,
      snapshot,
      source: "server",
    });
  }

  async function persistCreatePipelineSnapshot(input: {
    session: Session;
    turnId: string;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
    source: RuntimeEvent["source"];
  }): Promise<Turn> {
    const result = await updateStoredTurn(input.turnId, (current) => {
      if (current.sessionId !== input.session.id) throw new Error("Turn not found");
      return {
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          createPipelineRequest: input.request ?? current.createPipelineRequest ?? input.snapshot.request,
          createPipeline: input.snapshot,
        },
        createPipelineRequest: input.request ?? current.createPipelineRequest ?? input.snapshot.request,
        createPipeline: input.snapshot,
      };
    });
    if (!result) throw new Error("Turn not found");
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: result.id,
        name: "create_pipeline.updated",
        source: input.source,
        appId: input.session.appId,
        status: createPipelineRuntimeEventStatus(input.snapshot),
        output: input.snapshot.blockedReason ?? input.snapshot.plan?.summary ?? input.snapshot.state,
        data: {
          createPipelineRequest: result.createPipelineRequest,
          createPipeline: input.snapshot,
        },
      }),
    );
    await syncCreatePlanApproval({
      session: input.session,
      turn: result,
      request: result.createPipelineRequest ?? input.request ?? input.snapshot.request,
      snapshot: input.snapshot,
    });
    return result;
  }

  async function findApproval(approvalId: string): Promise<Approval | null> {
    return store.getApproval(approvalId);
  }

  async function setTurnProviderTurnId(
    sessionId: string,
    turnId: string,
    providerTurnId: string,
  ): Promise<void> {
    await updateStoredTurn(turnId, (current) => {
      if (current.sessionId !== sessionId) return current;
      return {
        ...current,
        providerTurnId,
      };
    });
  }

  return { sendTurn, interruptSessionTurn, updateTurnCreatePipeline, resolveCreatePipelineApproval };
}

function shouldRunCreatePipelinePlanner(snapshot: CreatePipelineSnapshot): boolean {
  return snapshot.state === "planning" && !snapshot.plan;
}

function threadGoalFromTurnMetadata(metadata: SendTurnRequest["metadata"]): {
  output: string;
  data: Record<string, unknown>;
} | null {
  const value = metadata?.threadGoal;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const objective = typeof record.objective === "string" && record.objective.trim()
    ? record.objective.trim()
    : "Goal runtime updated";
  const provider = typeof record.provider === "string" && record.provider.trim()
    ? record.provider.trim()
    : "openpond";
  return {
    output: objective,
    data: {
      kind: "thread_goal",
      provider,
      goal: record,
    },
  };
}

type CreatePipelinePlanStatus = NonNullable<CreatePipelineSnapshot["plan"]>["status"];

function approvalStatusForPlan(status: CreatePipelinePlanStatus): Approval["status"] {
  if (status === "approved") return "accepted";
  if (status === "rejected") return "declined";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

function createPlanApproval(input: {
  existing?: Approval | null;
  session: Session;
  turn: Turn;
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot;
  status: Approval["status"];
}): Approval {
  const plan = input.snapshot.plan;
  const createdAt = input.existing?.createdAt ?? input.snapshot.createdAt;
  return {
    id: plan?.approvalId ?? `approval_${input.snapshot.id}`,
    sessionId: input.session.id,
    turnId: input.turn.id,
    providerRequestId: input.snapshot.id,
    kind: "create_plan",
    title: `${input.request.operation === "edit" ? "Approve edit plan" : "Approve create plan"}: ${input.request.objective}`,
    detail: JSON.stringify(
      {
        requestId: input.request.id,
        pipelineId: input.snapshot.id,
        planId: plan?.id ?? null,
        objective: input.request.objective,
        summary: plan?.summary ?? null,
        sourcePlan: plan?.sourcePlan ?? [],
        requirements: plan?.requirements ?? [],
        checks: plan?.checks ?? [],
        workflowCaptureId: input.snapshot.workflowCapture?.id ?? null,
      },
      null,
      2,
    ),
    status: input.status,
    createdAt,
  };
}

function createPlanDecisionSnapshot(
  snapshot: CreatePipelineSnapshot,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
): CreatePipelineSnapshot {
  const timestamp = now();
  const approved = decision === "accept" || decision === "acceptForSession";
  const cancelled = decision === "cancel";
  const blockedReason = approved
    ? null
    : cancelled
      ? "Create plan cancelled before source mutation."
      : "Create plan rejected before source mutation.";
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: approved ? "applying_source" : "blocked",
    plan: snapshot.plan
      ? {
          ...snapshot.plan,
          status: approved ? "approved" : cancelled ? "cancelled" : "rejected",
          approvedAt: approved ? snapshot.plan.approvedAt ?? timestamp : null,
          metadata: approved
            ? snapshot.plan.metadata
            : {
                ...snapshot.plan.metadata,
                blockedReason,
              },
          updatedAt: timestamp,
        }
      : null,
    blockedReason,
    updatedAt: timestamp,
  });
}

function createPipelineRuntimeEventStatus(
  snapshot: CreatePipelineSnapshot,
): RuntimeEvent["status"] {
  if (snapshot.state === "awaiting_questions" || snapshot.state === "awaiting_plan_approval") return "pending";
  if (
    snapshot.state === "applying_source" ||
    snapshot.state === "running_checks" ||
    snapshot.state === "pushing_hosted" ||
    snapshot.state === "running_hosted_checks"
  ) {
    return "started";
  }
  if (
    snapshot.state === "blocked" ||
    snapshot.state === "failed" ||
    snapshot.state === "cancelled"
  ) {
    return "failed";
  }
  return "completed";
}

function createPipelineBackgroundFailureSnapshot(
  snapshot: CreatePipelineSnapshot,
  message: string,
): CreatePipelineSnapshot {
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "blocked",
    blockedReason: message,
    metadata: {
      ...snapshot.metadata,
      localCreatePipeline: {
        status: "blocked",
        reason: "local_create_background_apply_failed",
      },
    },
    updatedAt: now(),
  });
}

export function normalizeMentionedSandboxToolRequest(input: {
  request: WorkspaceToolRequest;
  mentionedApps: OpenPondApp[];
  userPrompt: string;
}): WorkspaceToolRequest {
  void input.mentionedApps;
  void input.userPrompt;
  return input.request;
}
