import {
  ChatAttachmentSummarySchema,
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
  WorkspaceDiffSummarySchema,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type RuntimeEvent,
  type WorkspaceDiffSummary,
} from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import { appendActionRunMessage, actionRunSummaryFromEvent } from "./chat-action-runs";
import {
  appendActivityToList,
  appendActivityMessage,
  appendCompactionStatus,
  codexControlMessage,
  isCodexGoalContextEvent,
  isCompactionEvent,
} from "./chat-activities";
import { insightsRunPromptSummaryFromTurnStarted } from "./chat-insights";
import { asRecord, findLast } from "./chat-message-utils";

export { activityGroupSummary } from "./chat-activities";

const chatMessagesCache = new WeakMap<RuntimeEvent[], ChatMessage[]>();

export function buildCachedChatMessages(items: RuntimeEvent[]): ChatMessage[] {
  const cached = chatMessagesCache.get(items);
  if (cached) return cached;
  const messages = buildChatMessages(items);
  chatMessagesCache.set(items, messages);
  return messages;
}

export function buildChatMessages(items: RuntimeEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const createPipelineTurnIds = createPipelineTurnIdSet(items);

  for (const item of items) {
    if (item.name === "turn.started") {
      const prompt = extractPrompt(item.args);
      if (prompt) {
        const marker = codexControlMessage(prompt);
        if (marker) {
          appendActivityMessage(messages, {
            ...item,
            name: marker.kind === "turn_aborted" ? "turn.interrupted" : "diagnostic",
            source: "provider",
            output: marker.text,
            data: {
              ...(asRecord(item.data) ?? {}),
              kind: marker.kind,
            },
          });
          continue;
        }
        const insightsRunPrompt = insightsRunPromptSummaryFromTurnStarted(item.args, prompt);
        messages.push({
          id: item.id,
          role: "user",
          content: insightsRunPrompt ? undefined : prompt,
          attachments: extractAttachments(item.args),
          ...(insightsRunPrompt ? { insightsRunPrompt } : {}),
          timestamp: item.timestamp,
          turnId: item.turnId,
        });
        const createPipeline = extractCreatePipeline(item.args);
        if (createPipeline.request) {
          messages.push({
            id: `${item.id}:create-pipeline`,
            role: "assistant",
            timestamp: item.timestamp,
            turnId: item.turnId,
            createPipelineRequest: createPipeline.request,
            createPipeline: createPipeline.snapshot,
          });
        }
      }
      continue;
    }

    if (item.name === "create_pipeline.updated") {
      const createPipeline = extractCreatePipeline(item.data);
      if (!createPipeline.request) continue;
      const existing = findLast(
        messages,
        (candidate) => candidate.turnId === item.turnId && Boolean(candidate.createPipelineRequest),
      );
      if (existing) {
        existing.createPipelineRequest = createPipeline.request;
        existing.createPipeline = createPipeline.snapshot;
        existing.timestamp = item.timestamp;
      } else {
        messages.push({
          id: `${item.id}:create-pipeline`,
          role: "assistant",
          timestamp: item.timestamp,
          turnId: item.turnId,
          createPipelineRequest: createPipeline.request,
          createPipeline: createPipeline.snapshot,
        });
      }
      continue;
    }

    if (item.name === "assistant.delta") {
      if (item.turnId && createPipelineTurnIds.has(item.turnId)) {
        appendCreatePipelineDebugActivity(messages, item);
        continue;
      }
      const content = item.output ?? "";
      if (!content) continue;
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant" && previous.turnId === item.turnId) {
        previous.content = `${previous.content ?? ""}${content}`;
        previous.timestamp = item.timestamp;
      } else {
        messages.push({
          id: item.id,
          role: "assistant",
          content,
          timestamp: item.timestamp,
          turnId: item.turnId,
        });
      }
      continue;
    }

    if (item.name === "turn.failed") {
      messages.push({
        id: item.id,
        role: "error",
        content: item.error ?? "Turn failed",
        timestamp: item.timestamp,
        turnId: item.turnId,
      });
      continue;
    }

    if (isCompactionEvent(item)) {
      appendCompactionStatus(messages, item);
      continue;
    }

    if (
      item.name === "tool.started" ||
      item.name === "tool.completed" ||
      item.name === "command.output" ||
      item.name === "workspace_action" ||
      item.name === "workspace_action_result" ||
      item.name === "approval.requested" ||
      item.name === "turn.interrupted" ||
      isCodexGoalContextEvent(item)
    ) {
      if (item.turnId && createPipelineTurnIds.has(item.turnId)) {
        appendCreatePipelineDebugActivity(messages, item);
        continue;
      }
      const actionRun = actionRunSummaryFromEvent(item);
      if (actionRun) {
        appendActionRunMessage(messages, item, actionRun);
        continue;
      }
      appendActivityMessage(messages, item);
    }

    if (item.name === "workspace.diff") {
      if (item.turnId && createPipelineTurnIds.has(item.turnId)) {
        appendCreatePipelineDebugActivity(messages, item);
        continue;
      }
      const summary = parseWorkspaceDiffSummary(item.data);
      if (!summary || summary.filesChanged === 0) continue;
      const assistant = findLast(
        messages,
        (candidate) => candidate.role === "assistant" && candidate.turnId === item.turnId
      );
      if (assistant) {
        assistant.changeSummary = summary;
        assistant.timestamp = item.timestamp;
      }
    }
  }

  return messages;
}

function appendCreatePipelineDebugActivity(messages: ChatMessage[], item: RuntimeEvent): void {
  const createMessage = findLast(
    messages,
    (candidate) => candidate.turnId === item.turnId && Boolean(candidate.createPipelineRequest),
  );
  if (!createMessage) return;
  createMessage.createPipelineDebugActivities = appendActivityToList(
    createMessage.createPipelineDebugActivities ?? [],
    item,
  );
  createMessage.timestamp = item.timestamp;
}

function createPipelineTurnIdSet(items: RuntimeEvent[]): Set<string> {
  const turnIds = new Set<string>();
  for (const item of items) {
    if (!item.turnId) continue;
    if (item.name === "turn.started" && extractCreatePipeline(item.args).request) {
      turnIds.add(item.turnId);
      continue;
    }
    if (item.name === "create_pipeline.updated" && extractCreatePipeline(item.data).request) {
      turnIds.add(item.turnId);
    }
  }
  return turnIds;
}

function parseWorkspaceDiffSummary(value: unknown): WorkspaceDiffSummary | null {
  const parsed = WorkspaceDiffSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractPrompt(value: unknown): string {
  if (!value || typeof value !== "object" || !("prompt" in value)) return "";
  const prompt = (value as { prompt?: unknown }).prompt;
  return typeof prompt === "string" ? prompt : "";
}

function extractAttachments(value: unknown): ChatMessage["attachments"] {
  if (!value || typeof value !== "object" || !("attachments" in value)) return undefined;
  const parsed = ChatAttachmentSummarySchema.array().safeParse(
    (value as { attachments?: unknown }).attachments,
  );
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

function extractCreatePipeline(value: unknown): {
  request: CreatePipelineRequest | null;
  snapshot: CreatePipelineSnapshot | null;
} {
  const record = asRecord(value);
  if (!record) return { request: null, snapshot: null };
  const snapshot = CreatePipelineSnapshotSchema.safeParse(record.createPipeline);
  const request = CreatePipelineRequestSchema.safeParse(record.createPipelineRequest);
  if (snapshot.success) {
    return {
      request: request.success ? request.data : snapshot.data.request,
      snapshot: snapshot.data,
    };
  }
  return {
    request: request.success ? request.data : null,
    snapshot: null,
  };
}

export function relativeAge(value: string | null | undefined): string {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatMessageTimestamp(value: string | null | undefined): string {
  const date = parseTimestamp(value);
  if (!date) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatMessageTimestampTitle(value: string | null | undefined): string {
  const date = parseTimestamp(value);
  return date ? date.toLocaleString() : "";
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
