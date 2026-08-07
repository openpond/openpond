import {
  DEFAULT_SESSION_EXPERIENCE,
  type AppPreferences,
  type ChatProvider,
  type HarnessActionBinding,
  type ModelUsageRecord,
  type OpenPondActionCatalogEntry,
  type OpenPondApp,
  type RuntimeEvent,
  type Session,
  type SubagentRoleSettings,
  type Taskset,
  type Turn,
  type WorkspaceDiffSummary,
  type WorkspaceToolRequest,
} from "@openpond/contracts";
import {
  createAgentToolCatalogProjection,
  providerRoundSequence,
} from "@openpond/agent-runtime";
import type { HostedChatTool, HostedChatToolChoice } from "@openpond/cloud";
import { buildChatMessagesForProvider } from "../../openpond/hosted-chat.js";
import { trustedProviderContextLimit } from "../../openpond/context-usage.js";
import {
  extractProfileSkillReadRequests,
  extractWorkspaceToolRequests,
  formatWorkspaceToolResultForModel,
  formatWorkspaceToolValidationErrorForModel,
  validateWorkspaceToolRequest,
  type HostedToolInstructionMode,
} from "../../openpond/hosted-tool-protocol.js";
import {
  assistantMessageForNativeToolCalls,
  NativeToolCallAccumulator,
  toolResultMessage,
  type NativeModelToolResult,
} from "../../openpond/native-tool-calls.js";
import {
  enabledModelToolDefinitions,
  modelToolDefinitionToHostedTool,
  type ModelToolDefinition,
} from "../../openpond/model-tool-registry.js";
import type { ProfileSkillInstructionMode } from "../../openpond/hosted-turn-helpers.js";
import type { ResolvedConnectedAppContext } from "../../openpond/connected-app-context.js";
import { event } from "../../utils.js";
import { requiresWorkspaceToolForPrompt } from "../workspace-tool-requirements.js";
import { startProviderRequestUsageRecorder } from "../model-usage-recorder.js";
import {
  hostedToolInstructionModeForProvider,
  type HostedToolRolloutFlags,
} from "./rollout.js";
import type { ProfileSkillRuntime } from "./native-tools-runtime.js";
import type { SubagentTurnPermissions } from "../subagents/continuation-runtime.js";
import type {
  HostedToolLoopDelta,
  TurnRunnerDependencies,
} from "../turns/ports.js";
import { isTerminalOneShotTurn } from "../turns/request-context.js";
import {
  recordFromUnknown,
} from "../turns/value-utils.js";
import { normalizeMentionedSandboxToolRequest } from "../create-pipeline/snapshots.js";
import {
  filterModelToolsForExperience,
  workspaceToolExperienceBlocker,
} from "../experience-policy.js";
import { hostedTrainingHarnessRound } from "./training-harness-round.js";
import {
  READ_ONLY_SUBAGENT_WORKSPACE_TOOL_ACTIONS,
  RESOURCE_TEXT_FALLBACK_ACTIONS,
} from "./tool-loop-action-policy.js";
import { subagentModelAsideMessages } from "./tool-loop-subagent-asides.js";

export { hostedTrainingHarnessRound } from "./training-harness-round.js";

type HostedMessages = ReturnType<typeof buildChatMessagesForProvider>;
type HostedToolLoopStreamOptions = {
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
  requestId?: string;
};

export function createHostedToolLoopRuntime(deps: {
  hostedToolFlags: HostedToolRolloutFlags;
  nativeToolsEnabledForProvider(provider: ChatProvider): boolean;
  createNativeModelToolDefinitions(
    openPondActionCatalog: OpenPondActionCatalogEntry[],
    runtimeEvents: RuntimeEvent[],
    profileSkillRuntime: ProfileSkillRuntime,
    connectedApps: ResolvedConnectedAppContext[],
    options?: {
      disableWorkflowDelegationTools?: boolean;
      subagentRoles?: readonly SubagentRoleSettings[];
      subagentToolsEnabled?: boolean;
      trainingHarness?: {
        taskId: string;
        actionBindings: HarnessActionBinding[];
      };
      workInputs?: ReadonlyArray<{
        localPath?: string;
        storageName?: string;
      }>;
    }
  ): ModelToolDefinition[];
  profileSkillInstructionModeForProvider(
    provider: ChatProvider,
    runtime: ProfileSkillRuntime
  ): ProfileSkillInstructionMode;
  subagentToolsAvailable(): boolean;
  runtimeEventsForSession(
    sessionId: string,
    query?: {
      afterSequence?: number | null;
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
    }
  ): Promise<RuntimeEvent[]>;
  getSession(sessionId: string): Promise<Session>;
  recordTurnToolCatalog?(input: {
    turnId: string;
    hash: string;
    capabilities: Array<Record<string, unknown>>;
  }): Promise<void>;
  getTaskset?: (tasksetId: string) => Promise<Taskset | null>;
  appendHostedContextUsage: TurnRunnerDependencies["appendHostedContextUsage"];
  maxHostedWorkspaceToolRounds: number;
  maxRepeatedInvalidToolRequests: number;
  appendRuntimeEvent: TurnRunnerDependencies["appendRuntimeEvent"];
  processHarnessImprovementBoundary?:
    TurnRunnerDependencies["processHarnessImprovementBoundary"];
  upsertModelUsageRecord(record: ModelUsageRecord): Promise<void>;
  executeNativeToolCalls(input: {
    session: Session;
    turnId: string;
    turnPermissions: SubagentTurnPermissions;
    provider: ChatProvider;
    model: string;
    signal: AbortSignal;
    workspaceDiffBaseline: WorkspaceDiffSummary | null;
    mentionedApps: OpenPondApp[];
    userPrompt: string;
    turnMetadata: Turn["metadata"];
    toolDefinitions: Map<string, ModelToolDefinition>;
    invalidRequestCounts: Map<string, number>;
    toolCalls: import("../../openpond/native-tool-calls.js").NativeModelToolCall[];
  }): Promise<NativeModelToolResult[]>;
  readProfileSkillForModel(input: {
    session: Session;
    turnId: string;
    runtime: ProfileSkillRuntime;
    name: string;
    source: "provider" | "server";
  }): Promise<string>;
  executeWorkspaceTool: TurnRunnerDependencies["executeWorkspaceTool"];
  appendAssistantText: TurnRunnerDependencies["appendAssistantText"];
  throwIfInterrupted(signal: AbortSignal): void;
}) {
  const hostedToolFlags = deps.hostedToolFlags;
  const nativeToolsEnabledForProvider = deps.nativeToolsEnabledForProvider;
  const createNativeModelToolDefinitions =
    deps.createNativeModelToolDefinitions;
  const profileSkillInstructionModeForProvider =
    deps.profileSkillInstructionModeForProvider;
  const subagentToolsAvailable = deps.subagentToolsAvailable;
  const appendHostedContextUsage = deps.appendHostedContextUsage;
  const maxHostedWorkspaceToolRounds = deps.maxHostedWorkspaceToolRounds;
  const maxRepeatedInvalidToolRequests = deps.maxRepeatedInvalidToolRequests;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const processHarnessImprovementBoundary =
    deps.processHarnessImprovementBoundary;
  const recordCompletedToolBatch = (session: Session, turn: Turn) =>
    processHarnessImprovementBoundary?.({ session, turn, boundaryKind: "completed_tool_batch" });
  const safeUpsertModelUsageRecord = deps.upsertModelUsageRecord;
  const executeNativeToolCalls = deps.executeNativeToolCalls;
  const readProfileSkillForModel = deps.readProfileSkillForModel;
  const executeWorkspaceTool = deps.executeWorkspaceTool;
  const appendAssistantText = deps.appendAssistantText;
  const throwIfInterrupted = deps.throwIfInterrupted;
  const store = { runtimeEventsForSession: deps.runtimeEventsForSession };
  const getSession = deps.getSession;
  async function runHostedToolLoop(params: {
    session: Session;
    turn: Turn;
    turnPermissions: SubagentTurnPermissions;
    provider: ChatProvider;
    model: string;
    messages: HostedMessages;
    contextLimitTokens?: number | null;
    resourceEvents: RuntimeEvent[];
    mentionedApps: OpenPondApp[];
    connectedApps: ResolvedConnectedAppContext[];
    openPondActionCatalog: OpenPondActionCatalogEntry[];
    profileSkillRuntime: ProfileSkillRuntime;
    workInputs?: ReadonlyArray<{
      localPath?: string;
      storageName?: string;
    }>;
    userPrompt: string;
    workspaceDiffBaseline: WorkspaceDiffSummary | null;
    signal: AbortSignal;
    stream: (
      messages: HostedMessages,
      options?: HostedToolLoopStreamOptions
    ) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
    appPreferences: AppPreferences | null;
  }): Promise<Session> {
    let session = params.session;
    const messages = [...params.messages];
    const contextLimitTokens =
      params.contextLimitTokens ??
      trustedProviderContextLimit({
        provider: params.provider,
        model: params.model,
      });
    const invalidRequestCounts = new Map<string, number>();
    let workspaceToolResultCount = 0;
    let toolRequiredCorrectionSent = false;
    const appPreferences = params.appPreferences;
    const trainingHarness = await trainingHarnessForTurn(
      params.turn,
      deps.getTaskset
    );
    const nativeToolDefinitions = nativeToolsEnabledForProvider(params.provider)
      ? filterModelToolsForExperience(
          session,
          enabledModelToolDefinitions(
            createNativeModelToolDefinitions(
              params.openPondActionCatalog,
              params.resourceEvents,
              params.profileSkillRuntime,
              params.connectedApps,
              {
                disableWorkflowDelegationTools: isTerminalOneShotTurn(
                  params.turn
                ),
                subagentRoles: appPreferences?.subagents.roles.filter(
                  (role) => role.enabled
                ),
                subagentToolsEnabled:
                  appPreferences?.subagents.enabled ?? false,
                trainingHarness,
                workInputs: params.workInputs,
              }
            ),
            {
              session,
              provider: params.provider,
              model: params.model,
              mentionedApps: params.mentionedApps,
            }
          )
        )
      : [];
    const nativeTools = nativeToolDefinitions.map(
      modelToolDefinitionToHostedTool
    );
    const nativeToolDefinitionByName = new Map(
      nativeToolDefinitions.map((definition) => [definition.name, definition])
    );
    const effectiveToolCatalog = createAgentToolCatalogProjection(
      nativeToolDefinitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.parameters,
        placement: "local" as const,
        executorAvailable: typeof definition.execute === "function",
      })),
    );
    await deps.recordTurnToolCatalog?.({
      turnId: params.turn.id,
      hash: effectiveToolCatalog.hash,
      capabilities: effectiveToolCatalog.capabilities,
    });
    let completedTrainingHarnessActions = 0;
    const textFallbackMode = hostedToolInstructionModeForProvider(
      hostedToolFlags,
      params.provider
    );
    const profileSkillMode = profileSkillInstructionModeForProvider(
      params.provider,
      params.profileSkillRuntime
    );
    const initialEventIds = new Set(
      params.resourceEvents.map((item) => item.id)
    );
    let lastDeliveredSubagentAsideSequence = session.subagentRunId
      ? 0
      : params.resourceEvents.reduce(
          (latest, runtimeEvent) =>
            Math.max(latest, runtimeEvent.sequence ?? 0),
          0
        );
    const deliveredSubagentAsideKeys = new Set<string>();
    async function appendContextUsage(input: {
      messages: HostedMessages;
      usage?: unknown;
      includeCompletion?: boolean;
    }): Promise<void> {
      if (!contextLimitTokens) return;
      await appendHostedContextUsage({
        session,
        turnId: params.turn.id,
        provider: params.provider,
        model: params.model,
        messages: input.messages,
        maxContextTokens: contextLimitTokens,
        usage: input.usage,
        includeCompletion: input.includeCompletion,
      });
    }
    async function appendPendingSubagentAsides(): Promise<boolean> {
      if (!subagentToolsAvailable()) return false;
      const pendingEvents = await store.runtimeEventsForSession(session.id, {
        afterSequence: lastDeliveredSubagentAsideSequence,
      });
      lastDeliveredSubagentAsideSequence = pendingEvents.reduce(
        (latest, runtimeEvent) =>
          Math.max(latest, runtimeEvent.sequence ?? latest),
        lastDeliveredSubagentAsideSequence
      );
      const asideMessages = subagentModelAsideMessages({
        session,
        events: pendingEvents,
        initialEventIds,
        deliveredKeys: deliveredSubagentAsideKeys,
      });
      if (asideMessages.length === 0) return false;
      for (const content of asideMessages) {
        messages.push({ role: "user", content });
      }
      return true;
    }
    for await (const round of providerRoundSequence({
      turnId: params.turn.id,
      maxRounds: maxHostedWorkspaceToolRounds,
      signal: params.signal,
    })) {
      const { index } = round;
      throwIfInterrupted(params.signal);
      await appendPendingSubagentAsides();
      await appendContextUsage({ messages });
      let assistantText = "";
      let reasoningText = "";
      let latestContinuation:
        | import("@openpond/cloud").HostedChatContinuation
        | null = null;
      let latestUsage: unknown;
      let finishReason: string | null | undefined;
      const nativeToolAccumulator = new NativeToolCallAccumulator();
      const usageRequestId = round.requestId;
      const usageRecorder = await startProviderRequestUsageRecorder({
        session,
        turn: params.turn,
        provider: params.provider,
        model: params.model,
        requestId: usageRequestId,
        requestOrdinal: index,
        upsert: safeUpsertModelUsageRecord,
      });
      const trainingHarnessRound = hostedTrainingHarnessRound({
        trainingHarness,
        completedActionCount: completedTrainingHarnessActions,
        nativeTools,
      });
      try {
        const requestTools = trainingHarnessRound?.tools ?? nativeTools;
        const toolChoice: HostedChatToolChoice =
          trainingHarnessRound?.toolChoice ?? "auto";
        for await (const delta of params.stream(
          messages,
          requestTools.length > 0
            ? { tools: requestTools, toolChoice, requestId: usageRequestId }
            : { requestId: usageRequestId }
        )) {
          throwIfInterrupted(params.signal);
          usageRecorder.observeDelta(delta);
          if (delta.usage) latestUsage = delta.usage;
          if (delta.text) assistantText += delta.text;
          if (delta.reasoningText) reasoningText += delta.reasoningText;
          if (delta.continuation) latestContinuation = delta.continuation;
          if (delta.toolCalls) nativeToolAccumulator.append(delta.toolCalls);
          if (delta.finishReason !== undefined)
            finishReason = delta.finishReason;
        }
      } catch (error) {
        await usageRecorder.fail(
          error,
          params.signal.aborted ||
            (error instanceof Error && error.name === "AbortError")
            ? "interrupted"
            : "failed"
        );
        throw error;
      }
      await usageRecorder.complete();
      if (reasoningText) {
        await appendRuntimeEvent(
          event({
            sessionId: session.id,
            turnId: params.turn.id,
            name: "assistant.reasoning.delta",
            source: "provider",
            appId: session.appId,
            output: reasoningText,
          })
        );
      }

      const nativeToolCalls = nativeToolAccumulator.completed();
      if (
        trainingHarnessRound?.requiredToolName &&
        (nativeToolCalls.length !== 1 ||
          nativeToolCalls[0]?.name !== trainingHarnessRound.requiredToolName)
      ) {
        await appendRuntimeEvent(
          event({
            sessionId: session.id,
            turnId: params.turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "failed",
            output: `The training harness required ${trainingHarnessRound.requiredToolName}, but the provider did not return exactly that one tool call.`,
            data: {
              provider: params.provider,
              model: params.model,
              requiredToolName: trainingHarnessRound.requiredToolName,
              receivedToolNames: nativeToolCalls.map((call) => call.name),
            },
          })
        );
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        messages.push({
          role: "user",
          content: `Call the required ${trainingHarnessRound.requiredToolName} function exactly once with valid JSON arguments. Do not answer in prose.`,
        });
        continue;
      }
      if (nativeToolCalls.length > 0) {
        messages.push(
          assistantMessageForNativeToolCalls(assistantText, nativeToolCalls, {
            continuation: latestContinuation,
          })
        );
        const nativeResults = await executeNativeToolCalls({
          session,
          turnId: params.turn.id,
          turnPermissions: params.turnPermissions,
          provider: params.provider,
          model: params.model,
          signal: params.signal,
          workspaceDiffBaseline: params.workspaceDiffBaseline,
          mentionedApps: params.mentionedApps,
          userPrompt: params.userPrompt,
          turnMetadata: params.turn.metadata,
          toolDefinitions: nativeToolDefinitionByName,
          invalidRequestCounts,
          toolCalls: nativeToolCalls,
        });
        workspaceToolResultCount += nativeResults.length;
        for (const result of nativeResults) {
          messages.push(toolResultMessage(result));
        }
        await recordCompletedToolBatch(session, params.turn);
        const blockingQuestion = nativeResults.find(
          (result) => result.turnControl === "await_user_input"
        );
        if (blockingQuestion) {
          await appendContextUsage({
            messages,
            usage: latestUsage,
            includeCompletion: true,
          });
          return session;
        }
        if (
          trainingHarnessRound?.requiredToolName &&
          nativeResults.some(
            (result) =>
              result.name === trainingHarnessRound.requiredToolName && result.ok
          )
        ) {
          completedTrainingHarnessActions += 1;
        }
        session = withDefaultExperience(await getSession(session.id));
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        continue;
      }

      if (finishReason === "tool_calls") {
        await appendRuntimeEvent(
          event({
            sessionId: session.id,
            turnId: params.turn.id,
            name: "diagnostic",
            source: "server",
            appId: session.appId,
            status: "failed",
            output:
              "Provider finished with tool_calls but did not stream a complete native tool call.",
            data: { provider: params.provider, model: params.model },
          })
        );
        messages.push({
          role: "user",
          content: [
            "The provider indicated a tool call, but no complete native tool call was received.",
            "Retry with one complete function call and valid JSON arguments, or answer normally if no tool is needed.",
          ].join(" "),
        });
        continue;
      }

      const assistantMessage = {
        role: "assistant" as const,
        content: assistantText.trim() || "Requesting workspace tool execution.",
      };
      const extractedRequests =
        textFallbackMode === "none"
          ? []
          : extractWorkspaceToolRequests(assistantText);
      const skillReadRequests =
        profileSkillMode === "text_fallback"
          ? extractProfileSkillReadRequests(assistantText)
          : [];
      const deniedTextFallbackRequests = extractedRequests.filter(
        (request) =>
          textFallbackMode === "resource_text_fallback" &&
          !RESOURCE_TEXT_FALLBACK_ACTIONS.has(request.action)
      );
      const requests = extractedRequests.filter(
        (request) =>
          textFallbackMode !== "resource_text_fallback" ||
          RESOURCE_TEXT_FALLBACK_ACTIONS.has(request.action)
      );
      const deniedSubagentPolicyResults = deniedTextFallbackRequests
        .map((request) => {
          const blocker = subagentWorkspaceToolPolicyBlocker(session, request);
          return blocker
            ? formatWorkspaceToolResultForModel({
                ok: false,
                action: request.action,
                output: blocker,
                data: {
                  code: "subagent_tool_policy_blocked",
                  toolPolicy: "read_only",
                  subagentRunId: session.subagentRunId ?? null,
                  subagentRoleId: session.subagentRoleId ?? null,
                },
              })
            : null;
        })
        .filter((result): result is string => Boolean(result));
      if (skillReadRequests.length > 0) {
        messages.push(assistantMessage);
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        const skillResults: string[] = [];
        for (const request of skillReadRequests.slice(0, 3)) {
          throwIfInterrupted(params.signal);
          skillResults.push(
            await readProfileSkillForModel({
              session,
              turnId: params.turn.id,
              runtime: params.profileSkillRuntime,
              name: request.name,
              source: "provider",
            })
          );
        }
        messages.push({
          role: "user",
          content: [
            "Profile skill result:",
            skillResults.join("\n\n"),
            "Continue. Follow the loaded skill instructions when relevant. If another profile skill is required, respond with exactly one openpond_skill block. Otherwise answer the user normally without tool JSON.",
          ].join("\n\n"),
        });
        continue;
      }
      if (deniedSubagentPolicyResults.length > 0 && requests.length === 0) {
        messages.push(assistantMessage);
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        messages.push({
          role: "user",
          content: [
            "Workspace tool result:",
            deniedSubagentPolicyResults.join("\n\n"),
            "Continue without mutating the workspace. If the assignment requires writes, report the isolation blocker.",
          ].join("\n\n"),
        });
        continue;
      }
      if (deniedTextFallbackRequests.length > 0 && requests.length === 0) {
        messages.push(assistantMessage);
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        messages.push({
          role: "user",
          content: [
            "That text fallback tool action is not available in this mode.",
            `Unavailable action${
              deniedTextFallbackRequests.length === 1 ? "" : "s"
            }: ${deniedTextFallbackRequests
              .map((request) => request.action)
              .join(", ")}.`,
            "Use native tool calls when available. If text fallback is necessary, only use resource_search or resource_read.",
          ].join(" "),
        });
        continue;
      }
      if (requests.length === 0) {
        messages.push(assistantMessage);
        if (await appendPendingSubagentAsides()) {
          await appendContextUsage({
            messages,
            usage: latestUsage,
            includeCompletion: true,
          });
          continue;
        }
        if (
          workspaceToolResultCount === 0 &&
          !toolRequiredCorrectionSent &&
          requiresWorkspaceToolForPrompt(session, params.userPrompt)
        ) {
          await appendContextUsage({
            messages,
            usage: latestUsage,
            includeCompletion: true,
          });
          messages.push({
            role: "user",
            content: workspaceToolCorrectionMessage(
              textFallbackMode,
              nativeTools.length > 0
            ),
          });
          toolRequiredCorrectionSent = true;
          continue;
        }
        await appendAssistantText(session, params.turn.id, assistantText);
        await appendContextUsage({
          messages,
          usage: latestUsage,
          includeCompletion: true,
        });
        return session;
      }

      messages.push(assistantMessage);
      await appendContextUsage({
        messages,
        usage: latestUsage,
        includeCompletion: true,
      });

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
        const policyBlocker = subagentWorkspaceToolPolicyBlocker(
          session,
          toolRequest
        );
        const experienceBlocker = workspaceToolExperienceBlocker({
          session,
          action: toolRequest.action,
        });
        if (policyBlocker || experienceBlocker) {
          toolResults.push(
            formatWorkspaceToolResultForModel({
              ok: false,
              action: toolRequest.action,
              output:
                policyBlocker ?? experienceBlocker ?? "Workspace tool blocked.",
              data: {
                code: policyBlocker
                  ? "subagent_tool_policy_blocked"
                  : "experience_tool_policy_blocked",
                toolPolicy: policyBlocker ? "read_only" : session.experience,
                subagentRunId: session.subagentRunId ?? null,
                subagentRoleId: session.subagentRoleId ?? null,
              },
            })
          );
          continue;
        }
        if (validationIssues.length > 0) {
          const key = `${toolRequest.action}:${validationIssues
            .map((issue) => `${issue.path}:${issue.expected}`)
            .join("|")}`;
          const count = (invalidRequestCounts.get(key) ?? 0) + 1;
          invalidRequestCounts.set(key, count);
          if (count >= maxRepeatedInvalidToolRequests) {
            throw new Error(
              `Hosted workspace tool produced repeated invalid ${
                toolRequest.action
              } requests: ${validationIssues
                .map((issue) => `${issue.path} expected ${issue.expected}`)
                .join("; ")}`
            );
          }
          toolResults.push(
            formatWorkspaceToolValidationErrorForModel(
              toolRequest,
              validationIssues
            )
          );
          continue;
        }
        const result = await executeWorkspaceTool(session.id, toolRequest, {
          turnId: params.turn.id,
          workspaceDiffBaseline: params.workspaceDiffBaseline,
        });
        workspaceToolResultCount += 1;
        session = withDefaultExperience(await getSession(session.id));
        toolResults.push(formatWorkspaceToolResultForModel(result));
      }

      await recordCompletedToolBatch(session, params.turn);

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

  function subagentWorkspaceToolPolicyBlocker(
    session: Session,
    request: WorkspaceToolRequest
  ): string | null {
    const policy = subagentToolPolicyForSession(session);
    if (policy !== "read_only") return null;
    if (READ_ONLY_SUBAGENT_WORKSPACE_TOOL_ACTIONS.has(request.action))
      return null;
    return [
      `Workspace action ${request.action} is blocked by the read_only subagent tool policy.`,
      "Use read/search/status/diff tools only, or report that this child assignment needs a write-capable isolated workspace.",
    ].join(" ");
  }

  function subagentToolPolicyForSession(
    session: Session
  ): SubagentRoleSettings["toolPolicy"] | null {
    if (!session.subagentRunId) return null;
    const subagent = recordFromUnknown(
      recordFromUnknown(session.metadata)?.subagent
    );
    const toolPolicy =
      typeof subagent?.toolPolicy === "string" ? subagent.toolPolicy : null;
    if (
      toolPolicy === "read_only" ||
      toolPolicy === "workspace_write" ||
      toolPolicy === "full_tools"
    )
      return toolPolicy;
    return "read_only";
  }

  function workspaceToolCorrectionMessage(
    textFallbackMode: HostedToolInstructionMode,
    nativeToolsAvailable: boolean
  ): string {
    const toolCallInstruction = nativeToolsAvailable
      ? "Call an appropriate native tool now."
      : textFallbackMode === "resource_text_fallback"
      ? "Call a resource_search or resource_read openpond_tool block now."
      : textFallbackMode === "full_text_fallback"
      ? "Call the appropriate openpond_tool block now."
      : "Explain the blocker instead of claiming the workspace changed.";
    return [
      "Your previous response did not call a workspace tool.",
      "The user's request appears to require inspecting or changing the active workspace.",
      toolCallInstruction,
      "Do not claim the workspace changed until a tool result confirms it.",
      "If the request cannot be completed with the available workspace tools, explain the blocker instead of saying it is done.",
    ].join(" ");
  }

  async function trainingHarnessForTurn(
    turn: Turn,
    getTaskset: ((tasksetId: string) => Promise<Taskset | null>) | undefined
  ): Promise<
    | {
        taskId: string;
        actionBindings: HarnessActionBinding[];
      }
    | undefined
  > {
    const tasksetId =
      typeof turn.metadata.trainingTasksetId === "string"
        ? turn.metadata.trainingTasksetId.trim()
        : "";
    const taskId =
      typeof turn.metadata.trainingHarnessTaskId === "string"
        ? turn.metadata.trainingHarnessTaskId.trim()
        : "";
    if (!tasksetId || !taskId || !getTaskset) return undefined;
    const taskset = await getTaskset(tasksetId);
    if (!taskset || taskset.environment.kind !== "stateful_harness") {
      return undefined;
    }
    const task = taskset.tasks.find((candidate) => {
      const caseId =
        typeof candidate.metadata.caseId === "string"
          ? candidate.metadata.caseId.trim()
          : "";
      return candidate.id === taskId || caseId === taskId;
    });
    if (!task) return undefined;
    const actionBindings = taskset.environment.actionBindings ?? [];
    return actionBindings.length ? { taskId, actionBindings } : undefined;
  }

  return { runHostedToolLoop };
}

function withDefaultExperience(session: Session): Session {
  return {
    ...session,
    experience: session.experience ?? DEFAULT_SESSION_EXPERIENCE,
  };
}
