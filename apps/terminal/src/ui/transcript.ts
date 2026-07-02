import type { RuntimeEvent } from "@openpond/contracts";

export const MAX_ACTIVE_TRANSCRIPT_ITEMS = 200;

export type TranscriptItem =
  | {
      id: string;
      kind: "user";
      text: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      streaming: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: "command";
      title: string;
      output: string;
      status: "running" | "succeeded" | "failed";
      createdAt: string;
    }
  | {
      id: string;
      kind: "tool";
      title: string;
      summary: string;
      status: "running" | "succeeded" | "failed";
      createdAt: string;
    }
  | {
      id: string;
      kind: "approval";
      title: string;
      body: string;
      status: "pending" | "approved" | "denied";
      createdAt: string;
    }
  | {
      id: string;
      kind: "system";
      tone: "info" | "warning" | "error";
      text: string;
      createdAt: string;
    };

export function itemId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function userItem(text: string): TranscriptItem {
  return { id: itemId("user"), kind: "user", text, createdAt: nowIso() };
}

export function systemItem(text: string, tone: "info" | "warning" | "error" = "info"): TranscriptItem {
  return { id: itemId("system"), kind: "system", tone, text, createdAt: nowIso() };
}

export function isTranscriptItemCommitReady(item: TranscriptItem): boolean {
  if (item.kind === "assistant") return !item.streaming;
  if (item.kind === "command" || item.kind === "tool") return item.status !== "running";
  if (item.kind === "approval") return item.status !== "pending";
  return true;
}

export function limitActiveTranscriptItems(
  items: TranscriptItem[],
  limit = MAX_ACTIVE_TRANSCRIPT_ITEMS,
): TranscriptItem[] {
  if (items.length <= limit) return items;
  return items.slice(Math.max(0, items.length - limit));
}

export function appendTranscriptItem(
  items: TranscriptItem[],
  item: TranscriptItem,
  limit = MAX_ACTIVE_TRANSCRIPT_ITEMS,
): TranscriptItem[] {
  return limitActiveTranscriptItems([...items, item], limit);
}

export function commitReadyTranscriptItems(
  items: TranscriptItem[],
  isReady: (item: TranscriptItem) => boolean = isTranscriptItemCommitReady,
): { readyItems: TranscriptItem[]; activeItems: TranscriptItem[] } {
  const readyItems: TranscriptItem[] = [];
  const activeItems: TranscriptItem[] = [];
  for (const item of items) {
    if (isReady(item)) readyItems.push(item);
    else activeItems.push(item);
  }
  return { readyItems, activeItems: limitActiveTranscriptItems(activeItems) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function approvalRequestedId(event: RuntimeEvent): string {
  return stringValue(asRecord(event.data), ["id", "approvalId", "approval_id"]) ?? event.id;
}

function approvalResolvedId(event: RuntimeEvent): string {
  return stringValue(asRecord(event.data), ["approvalId", "approval_id", "id"]) ?? event.id;
}

function toolEventId(event: RuntimeEvent): string {
  const data = asRecord(event.data);
  const stableId = stringValue(data, [
    "toolCallId",
    "tool_call_id",
    "workspaceToolCallId",
    "workspace_tool_call_id",
    "callId",
    "call_id",
    "itemId",
    "item_id",
    "id",
  ]);
  return stableId ? `${event.name.startsWith("workspace_") ? "workspace" : "tool"}-${stableId}` : event.id;
}

export function appendRuntimeEvent(items: TranscriptItem[], event: RuntimeEvent): TranscriptItem[] {
  if (event.name === "assistant.delta") {
    const delta = event.output ?? "";
    if (!delta) return items;
    const last = items[items.length - 1];
    if (last?.kind === "assistant" && last.streaming) {
      return limitActiveTranscriptItems([...items.slice(0, -1), { ...last, text: `${last.text}${delta}` }]);
    }
    return appendTranscriptItem(
      items,
      {
        id: event.turnId ? `assistant-${event.turnId}` : itemId("assistant"),
        kind: "assistant",
        text: delta,
        streaming: true,
        createdAt: event.timestamp,
      },
    );
  }

  if (event.name === "turn.completed") {
    return limitActiveTranscriptItems(
      items.map((item) => (item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item)),
    );
  }

  if (event.name === "turn.failed" || event.name === "turn.interrupted") {
    const tone = event.name === "turn.failed" ? "error" : "warning";
    const text = event.error || event.output || (event.name === "turn.failed" ? "Turn failed" : "Turn interrupted");
    return appendTranscriptItem(
      items.map((item) => (item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item)),
      systemItem(text, tone),
    );
  }

  if (event.name === "approval.requested") {
    return appendTranscriptItem(
      items,
      {
        id: approvalRequestedId(event),
        kind: "approval",
        title: event.action || "Approval requested",
        body: event.output || "Review the approval request in the app.",
        status: "pending",
        createdAt: event.timestamp,
      },
    );
  }

  if (event.name === "approval.resolved") {
    const approvalId = approvalResolvedId(event);
    return limitActiveTranscriptItems(
      items.map((item) =>
        item.kind === "approval" && item.id === approvalId
          ? { ...item, status: event.status === "completed" ? "approved" : "denied" }
          : item
      ),
    );
  }

  if (event.name === "command.output") {
    return appendTranscriptItem(
      items,
      {
        id: event.id,
        kind: "command",
        title: event.action || "command",
        output: event.output || "",
        status: event.error ? "failed" : "succeeded",
        createdAt: event.timestamp,
      },
    );
  }

  if (event.name === "tool.started" || event.name === "workspace_action") {
    return appendTranscriptItem(
      items,
      {
        id: toolEventId(event),
        kind: "tool",
        title: event.action || "tool",
        summary: event.output || "",
        status: "running",
        createdAt: event.timestamp,
      },
    );
  }

  if (event.name === "tool.completed" || event.name === "workspace_action_result") {
    const nextItem: TranscriptItem = {
      id: toolEventId(event),
      kind: "tool",
      title: event.action || "tool",
      summary: event.error || event.output || "",
      status: event.error || event.status === "failed" ? "failed" : "succeeded",
      createdAt: event.timestamp,
    };
    const index = items.findIndex((item) => item.kind === "tool" && item.id === nextItem.id);
    if (index === -1) return appendTranscriptItem(items, nextItem);
    return limitActiveTranscriptItems([...items.slice(0, index), nextItem, ...items.slice(index + 1)]);
  }

  if (event.name === "session.compaction.started") return appendTranscriptItem(items, systemItem("Compaction started"));
  if (event.name === "session.compaction.completed") return appendTranscriptItem(items, systemItem("Compaction completed"));
  if (event.name === "session.compaction.failed") return appendTranscriptItem(items, systemItem(event.error || "Compaction failed", "error"));

  return items;
}
