import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import {
  ContextUsageSnapshotSchema,
  ModelUsageRecordSchema,
  ResolveApprovalRequestSchema,
  SubagentRunSchema,
  type ContextUsageSnapshot,
  type Approval,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import {
  defaultServerRequestResult,
  type CodexNotification,
  type CodexServerRequest,
  type CodexServerRequestResult,
} from "@openpond/codex-provider";
import type { SqliteStore } from "../store/store.js";
import type { PendingApproval } from "../types.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "./background-worker-queue.js";
import { event, extractDelta, now, textFromUnknown } from "../utils.js";
import { normalizeWorkspaceFilePath, workspaceImageContentType } from "../workspace/workspace-common.js";

export function createCodexBridge(deps: {
  store: SqliteStore;
  upsertApproval: (approval: Approval) => Promise<void>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  providerRuntimeIngestionQueue: BackgroundWorkerQueue;
}) {
  const { store, upsertApproval, appendRuntimeEvent, providerRuntimeIngestionQueue } = deps;
  const pendingApprovals = new Map<string, PendingApproval>();
  const agentMessagePhases = new Map<string, CodexAgentMessagePhase>();

  async function resolveApproval(approvalId: string, payload: unknown): Promise<Approval> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const pending = pendingApprovals.get(approvalId);
    if (!pending) throw new Error("Approval not found or already resolved");
    pendingApprovals.delete(approvalId);
    const status =
      input.decision === "accept"
        ? "accepted"
        : input.decision === "acceptForSession"
          ? "accepted_for_session"
          : input.decision === "cancel"
            ? "cancelled"
            : "declined";
    const approval: Approval = { ...pending.approval, status };
    await upsertApproval(approval);
    await appendRuntimeEvent(
      event({
        sessionId: approval.sessionId,
        turnId: approval.turnId ?? undefined,
        name: "approval.resolved",
        source: "server",
        action: approval.kind,
        status: status === "accepted" || status === "accepted_for_session" ? "completed" : "failed",
        data: { decision: input.decision, approvalId },
      })
    );
    await safeMirrorSubagentApprovalResolved(approval);
    pending.resolve(toCodexApprovalResult(pending.request, input.decision));
    return approval;
  }

  async function handleCodexServerRequest(sessionId: string, request: CodexServerRequest): Promise<CodexServerRequestResult> {
    const kind = (() => {
      if (request.method === "item/commandExecution/requestApproval") return "command";
      if (request.method === "item/fileChange/requestApproval") return "file_change";
      if (request.method === "execCommandApproval") return "legacy_exec";
      if (request.method === "applyPatchApproval") return "legacy_patch";
      return null;
    })();
    if (!kind) return defaultServerRequestResult(request);

    const params = request.params && typeof request.params === "object" ? (request.params as Record<string, unknown>) : {};
    const approval: Approval = {
      id: randomUUID(),
      sessionId,
      turnId: typeof params.turnId === "string" ? params.turnId : null,
      providerRequestId: request.id,
      kind,
      title:
        typeof params.command === "string"
          ? params.command
          : kind === "file_change" || kind === "legacy_patch"
            ? "File change approval"
            : "Command approval",
      detail: typeof params.reason === "string" ? params.reason : textFromUnknown(params),
      status: "pending",
      createdAt: now(),
    };
    await upsertApproval(approval);
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId: approval.turnId ?? undefined,
        name: "approval.requested",
        source: "provider",
        action: kind,
        status: "pending",
        output: approval.title,
        data: approval,
      })
    );
    await safeMirrorSubagentApprovalRequested(approval);
    return new Promise<CodexServerRequestResult>((resolve) => {
      pendingApprovals.set(approval.id, { approval, request, resolve });
    });
  }

  function mapCodexNotification(
    sessionId: string,
    notification: CodexNotification,
  ): BackgroundWorkReceipt {
    return providerRuntimeIngestionQueue.enqueue(
      {
        label: "Codex provider notification",
        metadata: {
          sessionId,
          method: notification.method,
        },
      },
      () => ingestCodexNotification(sessionId, notification),
    );
  }

  async function ingestCodexNotification(sessionId: string, notification: CodexNotification): Promise<void> {
    const params = notification.params as Record<string, unknown> | undefined;
    const providerTurnId = stringValue(params, ["turnId", "turn_id"]);

    if (notification.method === "item/agentMessage/delta") {
      const context = await store.runtimeEventContext(sessionId, providerTurnId);
      const itemId = stringValue(params, ["itemId", "item_id"]);
      const phase = itemId ? agentMessagePhases.get(codexAgentMessageKey(sessionId, itemId)) : undefined;
      const commentary = phase === "commentary";
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: context.turnId ?? undefined,
          name: commentary ? "assistant.reasoning.delta" : "assistant.delta",
          source: "provider",
          appId: context.appId,
          action: commentary ? "codex_commentary" : undefined,
          output: extractDelta(notification.params),
          data: {
            provider: "codex",
            kind: commentary ? "commentary" : "agent_message",
            phase: phase ?? null,
            itemId: itemId ?? null,
          },
        })
      );
      return;
    }

    if (notification.method === "item/reasoning/summaryTextDelta") {
      const context = await store.runtimeEventContext(sessionId, providerTurnId);
      const itemId = stringValue(params, ["itemId", "item_id"]);
      const summaryIndex = numberValue(params, ["summaryIndex", "summary_index"]);
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: context.turnId ?? undefined,
          name: "assistant.reasoning.delta",
          source: "provider",
          appId: context.appId,
          action: "codex_reasoning_summary",
          output: extractDelta(notification.params),
          data: {
            provider: "codex",
            kind: "reasoning_summary",
            itemId: itemId ?? null,
            callId: itemId ? `${itemId}:${summaryIndex ?? 0}` : null,
            summaryIndex,
          },
        })
      );
      return;
    }

    if (isOutputDeltaNotification(notification.method)) {
      const context = await store.runtimeEventContext(sessionId, providerTurnId);
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: context.turnId ?? undefined,
          name: "command.output",
          source: "provider",
          appId: context.appId,
          output: extractDelta(notification.params),
        })
      );
      return;
    }

    const [turn, session, sessionEvents] = await Promise.all([
      providerTurnId
        ? store.turnByProviderTurnId(providerTurnId)
        : store.latestTurnForSession(sessionId, "in_progress"),
      store.getSession(sessionId),
      store.runtimeEventsForSession(sessionId),
    ]);
    const localTurnId = turn?.id;

    async function appendGoalClearedForTerminalTurn(): Promise<void> {
      if (!latestCodexGoalIsActive(sessionEvents, sessionId)) return;
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: localTurnId,
          name: "diagnostic",
          source: "provider",
          appId: session?.appId,
          status: "completed",
          output: "Goal cleared",
          data: {
            kind: "thread_goal_cleared",
            provider: "codex",
            threadId: stringValue(params, ["threadId", "thread_id"]) ?? null,
          },
        })
      );
    }

    if (notification.method === "thread/tokenUsage/updated") {
      const usageEvent = event({
        sessionId,
        turnId: localTurnId,
        name: "session.context.updated",
        source: "provider",
        appId: session?.appId,
      });
      const usageSnapshot = codexContextUsageSnapshot(params, usageEvent.id);
      if (!usageSnapshot) return;
      usageEvent.data = usageSnapshot;
      await appendRuntimeEvent(usageEvent);
      await appendCodexContextUsageRecord({
        session: session ?? undefined,
        turn: turn ?? undefined,
        usageEvent,
        usageSnapshot,
      });
      return;
    }

    if (notification.method === "thread/goal/updated") {
      const goal = asRecord(params?.goal);
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: localTurnId,
          name: "diagnostic",
          source: "provider",
          appId: session?.appId,
          status: "completed",
          output: goalObjective(goal) ?? "Goal runtime updated",
          data: {
            kind: "thread_goal",
            provider: "codex",
            goal,
          },
        })
      );
      return;
    }

    if (notification.method === "thread/goal/cleared") {
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: localTurnId,
          name: "diagnostic",
          source: "provider",
          appId: session?.appId,
          status: "completed",
          output: "Goal cleared",
          data: {
            kind: "thread_goal_cleared",
            provider: "codex",
            threadId: stringValue(params, ["threadId", "thread_id"]) ?? null,
          },
        })
      );
      return;
    }

    if (notification.method === "thread/compacted" || notification.method === "context_compacted") {
      const codexThreadId = stringValue(params, ["threadId", "thread_id"]);
      if (hasRecentCodexCompactionCompleted(sessionEvents, sessionId, codexThreadId)) return;
      const reason = codexCompactionReason(sessionEvents, sessionId, codexThreadId);
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: localTurnId,
          name: "session.compaction.completed",
          source: "provider",
          appId: session?.appId,
          status: "completed",
          output: reason === "auto" ? "Auto compacted conversation context" : "Compacted conversation context",
          data: {
            version: 1,
            provider: "codex",
            model: null,
            reason,
            mode: "native",
            codexThreadId: codexThreadId ?? null,
            providerTurnId: providerTurnId ?? null,
          },
        })
      );
      return;
    }

    if (notification.method === "item/started") {
      const item = params?.item as Record<string, unknown> | undefined;
      const type = typeof item?.type === "string" ? item.type : "";
      if (type === "agentMessage") {
        const itemId = stringValue(item, ["id"]);
        const phase = codexAgentMessagePhase(item);
        if (itemId && phase) {
          agentMessagePhases.set(codexAgentMessageKey(sessionId, itemId), phase);
        }
        return;
      }
      if (type === "contextCompaction") {
        const codexThreadId = stringValue(params, ["threadId", "thread_id"]);
        if (hasRecentCodexCompactionStarted(sessionEvents, sessionId, codexThreadId)) return;
        const reason = codexCompactionReason(sessionEvents, sessionId, codexThreadId);
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "session.compaction.started",
            source: "provider",
            appId: session?.appId,
            status: "started",
            output: reason === "auto" ? "Auto compacting conversation context" : "Compacting conversation context",
            data: {
              version: 1,
              provider: "codex",
              model: null,
              reason,
              mode: "native",
              codexThreadId: codexThreadId ?? null,
              providerTurnId: providerTurnId ?? null,
            },
          })
        );
        return;
      }
      if (type === "webSearch") {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "tool.started",
            source: "provider",
            appId: session?.appId,
            action: "web_search",
            status: "started",
            output: typeof item?.query === "string" ? item.query : "Web search",
            data: item,
          })
        );
        return;
      }
      if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall") {
        const data = augmentCodexToolItem(item, session?.cwd ?? null);
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "tool.started",
            source: "provider",
            appId: session?.appId,
            action: type,
            status: "started",
            output: typeof item?.command === "string" ? item.command : typeof item?.tool === "string" ? item.tool : type,
            data,
          })
        );
      }
      if (type === "fileChange") {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "workspace_action",
            source: "provider",
            appId: session?.appId,
            action: "file_change",
            status: "started",
            data: item,
          })
        );
      }
      return;
    }

    if (notification.method === "item/completed") {
      const item = params?.item as Record<string, unknown> | undefined;
      const type = typeof item?.type === "string" ? item.type : "";
      if (type === "agentMessage") {
        const itemId = stringValue(item, ["id"]);
        if (itemId) agentMessagePhases.delete(codexAgentMessageKey(sessionId, itemId));
        return;
      }
      if (type === "contextCompaction") {
        const codexThreadId = stringValue(params, ["threadId", "thread_id"]);
        if (hasRecentCodexCompactionCompleted(sessionEvents, sessionId, codexThreadId)) return;
        const reason = codexCompactionReason(sessionEvents, sessionId, codexThreadId);
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "session.compaction.completed",
            source: "provider",
            appId: session?.appId,
            status: "completed",
            output: reason === "auto" ? "Auto compacted conversation context" : "Compacted conversation context",
            data: {
              version: 1,
              provider: "codex",
              model: null,
              reason,
              mode: "native",
              codexThreadId: codexThreadId ?? null,
              providerTurnId: providerTurnId ?? null,
            },
          })
        );
        return;
      }
      if (type === "webSearch") {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "tool.completed",
            source: "provider",
            appId: session?.appId,
            action: "web_search",
            status: "completed",
            output: typeof item?.query === "string" ? item.query : "Web search",
            data: item,
          })
        );
        return;
      }
      if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall") {
        const data = augmentCodexToolItem(item, session?.cwd ?? null);
        const output =
          typeof item?.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : typeof item?.result === "string"
              ? item.result
              : typeof item?.tool === "string"
                ? item.tool
                : type;
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "tool.completed",
            source: "provider",
            appId: session?.appId,
            action: type,
            status: "completed",
            output,
            data,
          })
        );
      }
      if (type === "commandExecution" && typeof item?.aggregatedOutput === "string" && item.aggregatedOutput) {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "command.output",
            source: "provider",
            appId: session?.appId,
            output: item.aggregatedOutput,
            data: item,
          })
        );
      }
      if (type === "fileChange") {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "workspace_action_result",
            source: "provider",
            appId: session?.appId,
            action: "file_change",
            status: "completed",
            data: item,
          })
        );
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = asRecord(params?.turn);
      const turnStatus = stringValue(turn, ["status"]);
      if (turnStatus === "interrupted") {
        await appendRuntimeEvent(
          event({
            sessionId,
            turnId: localTurnId,
            name: "turn.interrupted",
            source: "provider",
            appId: session?.appId,
            status: "completed",
            output: "Stopped by user",
            data: params,
          })
        );
        await appendGoalClearedForTerminalTurn();
        return;
      }
      if (turnStatus && turnStatus !== "completed") return;
      await appendRuntimeEvent(
        event({
          sessionId,
          turnId: localTurnId,
          name: "turn.completed",
          source: "provider",
          appId: session?.appId,
          status: "completed",
          data: params,
        })
      );
      await appendGoalClearedForTerminalTurn();
    }
  }

  return {
    resolveApproval,
    handleCodexServerRequest,
    mapCodexNotification,
  };

  async function appendCodexContextUsageRecord(input: {
    session: Session | undefined;
    turn: Turn | undefined;
    usageEvent: RuntimeEvent;
    usageSnapshot: ContextUsageSnapshot;
  }): Promise<void> {
    const session = input.session;
    if (!session || typeof store.upsertModelUsageRecord !== "function") return;
    try {
      await store.upsertModelUsageRecord(codexContextUsageRecord({ ...input, session }));
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: session.id,
          turnId: input.turn?.id,
          name: "diagnostic",
          source: "server",
          appId: session.appId,
          status: "failed",
          output: textFromUnknown(error) || "Failed to persist Codex context usage record.",
          data: {
            kind: "model_usage_record_failed",
            provider: "codex",
            source: "codex_context_usage",
            usageEventId: input.usageEvent.id,
          },
        }),
      );
    }
  }

  async function safeMirrorSubagentApprovalRequested(approval: Approval): Promise<void> {
    try {
      await mirrorSubagentApprovalRequested(approval);
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: approval.sessionId,
          turnId: approval.turnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: textFromUnknown(error) || "Failed to mirror subagent approval request.",
          data: {
            kind: "subagent_approval_mirror_failed",
            approvalId: approval.id,
            phase: "requested",
          },
        }),
      ).catch(() => undefined);
    }
  }

  async function safeMirrorSubagentApprovalResolved(approval: Approval): Promise<void> {
    try {
      await mirrorSubagentApprovalResolved(approval);
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: approval.sessionId,
          turnId: approval.turnId ?? undefined,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: textFromUnknown(error) || "Failed to mirror subagent approval resolution.",
          data: {
            kind: "subagent_approval_mirror_failed",
            approvalId: approval.id,
            phase: "resolved",
          },
        }),
      ).catch(() => undefined);
    }
  }

  async function mirrorSubagentApprovalRequested(approval: Approval): Promise<void> {
    const context = await subagentApprovalContext(approval);
    if (!context) return;
    const blocker = `Waiting for approval: ${approval.title}`;
    const run = SubagentRunSchema.parse({
      ...context.run,
      status: "running",
      error: blocker,
      report: {
        ...(context.run.report ?? {}),
        summary: context.run.report?.summary || "Subagent is waiting for approval in the child conversation.",
        blockers: uniqueStrings([...(context.run.report?.blockers ?? []), blocker]),
        followUpNeeded: true,
      },
      metadata: {
        ...(context.run.metadata ?? {}),
        pendingApproval: subagentApprovalReceipt(approval),
      },
    });
    await store.upsertSubagentRun(run);
    await appendRuntimeEvent(
      event({
        sessionId: context.childSession.parentSessionId ?? context.run.parentSessionId,
        turnId: context.childSession.parentTurnId ?? context.run.parentTurnId ?? approval.turnId ?? undefined,
        name: "subagent.progress",
        source: "server",
        action: approval.kind,
        appId: context.childSession.appId,
        status: "pending",
        output: `Subagent ${context.run.roleId} is waiting for approval: ${approval.title}`,
        data: {
          run,
          approval: subagentApprovalReceipt(approval),
          childSessionId: context.childSession.id,
          parentGoalId: run.parentGoalId,
        },
      }),
    );
  }

  async function mirrorSubagentApprovalResolved(approval: Approval): Promise<void> {
    const context = await subagentApprovalContext(approval);
    if (!context) return;
    const accepted = approval.status === "accepted" || approval.status === "accepted_for_session";
    const resolvedApproval = subagentApprovalReceipt(approval);
    const metadata = {
      ...(context.run.metadata ?? {}),
      lastApproval: resolvedApproval,
    };
    delete (metadata as Record<string, unknown>).pendingApproval;
    const run = SubagentRunSchema.parse({
      ...context.run,
      status: "running",
      error: accepted ? null : `Approval ${approval.status}: ${approval.title}`,
      report: accepted
        ? clearApprovalOnlyReport(context.run.report)
        : {
            ...(context.run.report ?? {}),
            summary: context.run.report?.summary || "Subagent approval was not accepted.",
            blockers: uniqueStrings([
              ...(context.run.report?.blockers ?? []),
              `Approval ${approval.status}: ${approval.title}`,
            ]),
            followUpNeeded: true,
          },
      metadata,
    });
    await store.upsertSubagentRun(run);
    await appendRuntimeEvent(
      event({
        sessionId: context.childSession.parentSessionId ?? context.run.parentSessionId,
        turnId: context.childSession.parentTurnId ?? context.run.parentTurnId ?? approval.turnId ?? undefined,
        name: accepted ? "subagent.started" : "subagent.progress",
        source: "server",
        action: approval.kind,
        appId: context.childSession.appId,
        status: accepted ? "started" : "failed",
        output: accepted
          ? `Subagent ${context.run.roleId} approval accepted; child run is continuing.`
          : `Subagent ${context.run.roleId} approval ${approval.status}: ${approval.title}`,
        data: {
          run,
          approval: resolvedApproval,
          childSessionId: context.childSession.id,
          parentGoalId: run.parentGoalId,
        },
      }),
    );
  }

  async function subagentApprovalContext(approval: Approval): Promise<{
    childSession: Session;
    run: SubagentRun;
  } | null> {
    if (typeof store.getSubagentRun !== "function" || typeof store.upsertSubagentRun !== "function") {
      return null;
    }
    const childSession = await store.getSession(approval.sessionId);
    if (!childSession?.parentSessionId || !childSession.subagentRunId) return null;
    const run = await store.getSubagentRun(childSession.subagentRunId);
    if (!run) return null;
    return { childSession, run };
  }

  function subagentApprovalReceipt(approval: Approval): Record<string, unknown> {
    return {
      id: approval.id,
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      kind: approval.kind,
      title: approval.title,
      status: approval.status,
      createdAt: approval.createdAt,
    };
  }

  function clearApprovalOnlyReport(runReport: SubagentRun["report"]): SubagentRun["report"] {
    if (!runReport) return null;
    const blockers = runReport.blockers.filter((blocker) => !blocker.startsWith("Waiting for approval:"));
    if (
      !runReport.summary ||
      runReport.summary === "Subagent is waiting for approval in the child conversation."
    ) {
      return blockers.length > 0 ? { ...runReport, blockers, followUpNeeded: true } : null;
    }
    return { ...runReport, blockers };
  }

  function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values.filter((value) => value.trim()))];
  }
}

function codexContextUsageRecord(input: {
  session: Session;
  turn: Turn | undefined;
  usageEvent: RuntimeEvent;
  usageSnapshot: ContextUsageSnapshot;
}): ModelUsageRecord {
  const timestamp = input.usageEvent.timestamp;
  return ModelUsageRecordSchema.parse({
    id: `codex_context_${input.usageEvent.id}`,
    requestId: `codex:${input.session.id}:context:${input.usageEvent.id}`,
    requestOrdinal: 0,
    sessionId: input.session.id,
    turnId: input.turn?.id ?? null,
    provider: "codex",
    model: input.usageSnapshot.model || "codex",
    route: "codex_app_server",
    source: "codex_context_usage",
    requestKind: "codex_context",
    visibility: "background",
    status: "completed",
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    firstTokenMs: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: input.usageSnapshot.usedTokens,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "system",
      workflowKind: "other",
      sessionId: input.session.id,
      turnId: input.turn?.id ?? null,
      insightRunId: null,
      goalId: null,
      createImproveRunId: null,
      commandName: null,
      commandSource: null,
      appId: input.session.appId ?? null,
      workspaceKind: input.session.workspaceKind ?? null,
      workspaceId: input.session.workspaceId ?? null,
      localProjectId: input.session.localProjectId ?? null,
      cloudProjectId: input.session.cloudProjectId ?? null,
      sourceEventSequence: input.usageEvent.sequence ?? null,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(record: Record<string, unknown> | null | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function goalObjective(goal: Record<string, unknown> | null): string | undefined {
  return typeof goal?.objective === "string" && goal.objective.trim() ? goal.objective.trim() : undefined;
}

function latestCodexGoalIsActive(events: RuntimeEvent[], sessionId: string): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    if (item.sessionId !== sessionId || item.name !== "diagnostic") continue;
    const data = asRecord(item.data);
    if (data?.kind === "thread_goal_cleared" && data.provider === "codex") return false;
    if (data?.kind !== "thread_goal" || data.provider !== "codex") continue;
    return goalRecordIsActive(asRecord(data.goal));
  }
  return false;
}

function goalRecordIsActive(goal: Record<string, unknown> | null): boolean {
  const status = typeof goal?.status === "string" && goal.status.trim() ? goal.status.trim() : "active";
  const normalized = status.toLowerCase();
  return !(
    normalized.includes("complete") ||
    normalized.includes("achieved") ||
    normalized.includes("blocked") ||
    normalized.includes("limited") ||
    normalized.includes("paused") ||
    normalized.includes("stopped") ||
    normalized.includes("canceled") ||
    normalized.includes("cancelled") ||
    normalized.includes("interrupted") ||
    normalized.includes("aborted") ||
    normalized.includes("failed") ||
    normalized.includes("closed")
  );
}

function augmentCodexToolItem(
  item: Record<string, unknown> | undefined,
  cwd: string | null,
): Record<string, unknown> | undefined {
  if (!item || !isViewImageToolItem(item)) return item;
  const rawPath = findImagePathValue(item);
  const previewPath = rawPath ? workspaceRelativeImagePath(rawPath, cwd) : null;
  if (!previewPath) return item;
  return {
    ...item,
    openpondImagePreviewPath: previewPath,
  };
}

function isViewImageToolItem(item: Record<string, unknown>): boolean {
  const candidates = [
    stringValue(item, ["tool", "toolName", "tool_name", "name", "functionName", "function_name"]),
    stringValue(asRecord(item.input), ["tool", "toolName", "tool_name", "name"]),
    stringValue(asRecord(item.arguments), ["tool", "toolName", "tool_name", "name"]),
    stringValue(asRecord(item.args), ["tool", "toolName", "tool_name", "name"]),
  ].filter((value): value is string => Boolean(value));
  if (candidates.some((value) => value.toLowerCase().includes("view_image"))) return true;
  const command = stringValue(item, ["command", "title", "label"]);
  return Boolean(command?.toLowerCase().includes("view_image"));
}

function findImagePathValue(value: unknown, depth = 0, key = ""): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    if (isImagePathKey(key)) {
      const direct = imagePathCandidate(value);
      if (direct) return direct;
    }
    const parsed = parseMaybeJson(value);
    if (parsed !== null) {
      const nested = findImagePathValue(parsed, depth + 1, key);
      if (nested) return nested;
    }
    return extractImagePathFromText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = findImagePathValue(item, depth + 1, key);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const [childKey, child] of Object.entries(record)) {
    if (!isImagePathKey(childKey)) continue;
    const candidate = findImagePathValue(child, depth + 1, childKey);
    if (candidate) return candidate;
  }
  for (const [childKey, child] of Object.entries(record)) {
    if (isImagePathKey(childKey)) continue;
    const candidate = findImagePathValue(child, depth + 1, childKey);
    if (candidate) return candidate;
  }
  return null;
}

function isImagePathKey(key: string): boolean {
  return /^(path|filePath|filepath|imagePath|image|localPath|uri|url)$/i.test(key);
}

function parseMaybeJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function imagePathCandidate(value: string): string | null {
  const cleaned = cleanImagePathCandidate(value);
  return cleaned && workspaceImageContentType(cleaned) ? cleaned : null;
}

function extractImagePathFromText(value: string): string | null {
  const match = /(?:file:\/\/)?(?:\/|\.\/|[\w.-]+\/)[^\s"'`<>]+\.(?:avif|gif|jpe?g|png|webp)\b/i.exec(value);
  return match ? cleanImagePathCandidate(match[0]) : null;
}

function cleanImagePathCandidate(value: string): string | null {
  let cleaned = value.trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, "");
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      cleaned = cleaned.replace(/^file:\/\//, "");
    }
  }
  return cleaned;
}

function workspaceRelativeImagePath(rawPath: string, cwd: string | null): string | null {
  const cleaned = cleanImagePathCandidate(rawPath);
  if (!cleaned || !workspaceImageContentType(cleaned)) return null;
  if (!nodePath.isAbsolute(cleaned)) return normalizeWorkspaceFilePath(cleaned);
  if (!cwd) return null;
  const relative = nodePath.relative(nodePath.resolve(cwd), cleaned);
  if (!relative || relative.startsWith("..") || nodePath.isAbsolute(relative)) return null;
  return normalizeWorkspaceFilePath(relative);
}

function isOutputDeltaNotification(method: string): boolean {
  return (
    method === "command/exec/outputDelta" ||
    method === "process/outputDelta" ||
    method === "item/commandExecution/outputDelta"
  );
}

type CodexAgentMessagePhase = "commentary" | "final_answer";

function codexAgentMessagePhase(item: Record<string, unknown> | undefined): CodexAgentMessagePhase | null {
  const phase = stringValue(item, ["phase"]);
  return phase === "commentary" || phase === "final_answer" ? phase : null;
}

function codexAgentMessageKey(sessionId: string, itemId: string): string {
  return `${sessionId}:${itemId}`;
}

function numberValue(record: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

function recordValue(record: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) return value;
  }
  return null;
}

function codexContextUsageSnapshot(params: Record<string, unknown> | undefined, eventId: string): ContextUsageSnapshot | null {
  const usage = recordValue(params, ["tokenUsage", "token_usage", "usage"]);
  if (!usage) return null;
  const total = recordValue(usage, ["total", "totalTokenUsage", "total_token_usage"]) ?? usage;
  const last = recordValue(usage, ["last", "lastTokenUsage", "last_token_usage"]);
  const activeWindowUsage = last ?? total;
  const usedTokens = numberValue(activeWindowUsage, ["totalTokens", "total_tokens", "total"]);
  const maxContextTokens = numberValue(usage, [
    "modelContextWindow",
    "model_context_window",
    "contextWindow",
    "context_window",
    "maxContextTokens",
    "max_context_tokens",
  ]);
  if (usedTokens === null || !maxContextTokens) return null;
  const parsed = ContextUsageSnapshotSchema.safeParse({
    provider: "codex",
    model: stringValue(params, ["model"]) ?? "codex",
    usedTokens,
    maxContextTokens,
    usableContextTokens: maxContextTokens,
    percentFull: Math.min(100, Math.round((usedTokens / maxContextTokens) * 100)),
    source: "provider_usage",
    updatedAtEventId: eventId,
  });
  return parsed.success ? parsed.data : null;
}

function hasRecentCodexCompactionCompleted(
  events: RuntimeEvent[],
  sessionId: string,
  codexThreadId: string | undefined
): boolean {
  return Boolean(findRecentCodexCompactionEvent(events, sessionId, codexThreadId, "session.compaction.completed"));
}

function hasRecentCodexCompactionStarted(
  events: RuntimeEvent[],
  sessionId: string,
  codexThreadId: string | undefined
): boolean {
  return Boolean(findRecentCodexCompactionEvent(events, sessionId, codexThreadId, "session.compaction.started"));
}

function codexCompactionReason(
  events: RuntimeEvent[],
  sessionId: string,
  codexThreadId: string | undefined
): "auto" | "manual" {
  const started = findRecentCodexCompactionEvent(events, sessionId, codexThreadId, "session.compaction.started");
  const data = asRecord(started?.data);
  return data?.reason === "manual" ? "manual" : "auto";
}

function findRecentCodexCompactionEvent(
  events: RuntimeEvent[],
  sessionId: string,
  codexThreadId: string | undefined,
  name: "session.compaction.started" | "session.compaction.completed"
): RuntimeEvent | null {
  const cutoff = Date.now() - 60_000;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    const timestamp = Date.parse(item.timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoff) return null;
    if (item.sessionId !== sessionId || item.name !== name) continue;
    const data = asRecord(item.data);
    if (data?.provider !== "codex") continue;
    if (!codexThreadId || !data.codexThreadId || data.codexThreadId === codexThreadId) return item;
  }
  return null;
}

function toCodexApprovalResult(request: CodexServerRequest, decision: string): CodexServerRequestResult {
  const commandDecision = decision === "acceptForSession" ? "acceptForSession" : decision;
  if (request.method === "item/commandExecution/requestApproval") {
    return { result: { decision: commandDecision } };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return { result: { decision: commandDecision } };
  }
  const legacyDecision =
    decision === "accept"
      ? "approved"
      : decision === "acceptForSession"
        ? "approved_for_session"
        : decision === "cancel"
          ? "abort"
          : "denied";
  if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
    return { result: { decision: legacyDecision } };
  }
  return defaultServerRequestResult(request);
}
