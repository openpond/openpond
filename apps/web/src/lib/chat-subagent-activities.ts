import type { RuntimeEvent } from "@openpond/contracts";
import type { ActivityItem, ChatMessage } from "./app-models";
import { asRecord, parseMaybeJson, stringValue } from "./chat-message-utils";

export function settleSubagentActivityGroups(
  messages: ChatMessage[],
  item: RuntimeEvent,
  activity: ActivityItem,
): boolean {
  const terminalSubagent =
    item.name.startsWith("subagent.") &&
    !activity.subagentMessage &&
    (activity.state === "completed" || activity.state === "failed");
  if (terminalSubagent && activity.openSession) {
    for (const message of messages) {
      if (message.role !== "activity_group" || message.turnId !== item.turnId) continue;
      let changed = false;
      for (const previous of message.activities ?? []) {
        if (
          previous.openSession?.sessionId !== activity.openSession.sessionId ||
          (previous.state !== "running" && previous.state !== "pending")
        )
          continue;
        previous.state = activity.state;
        changed = true;
      }
      if (
        changed &&
        !message.activities?.some((entry) => entry.state === "running" || entry.state === "pending")
      ) {
        message.traceState = activity.state === "failed" ? "failed" : "settled";
        message.traceCompletedAt = item.timestamp;
      }
    }
  }
  return terminalSubagent;
}

export function activityStartedAgent(item: RuntimeEvent): string | undefined {
  if (item.action === "openpond_start_agent")
    return stringValue(asRecord(item.args), ["title"]) ?? undefined;
  if (item.name !== "subagent.started") return undefined;
  const data = asRecord(item.data);
  const run = asRecord(data?.run);
  return (
    stringValue(run, ["title", "name", "roleId"]) ??
    stringValue(data, ["title", "name", "roleId"]) ??
    undefined
  );
}

export function activityOpenSession(item: RuntimeEvent): ActivityItem["openSession"] | undefined {
  if (
    item.action === "openpond_start_agent" &&
    item.name === "tool.completed" &&
    item.status !== "failed"
  ) {
    const result =
      asRecord(asRecord(item.data)?.result) ?? asRecord(parseMaybeJson(item.output ?? ""));
    const sessionId = stringValue(result, ["sessionId"]);
    if (sessionId) return { sessionId, label: "Open conversation" };
  }
  if (!item.name.startsWith("subagent.")) return undefined;
  const data = asRecord(item.data);
  const run = asRecord(data?.run);
  const childSessionId =
    stringValue(data, ["childSessionId"]) ?? stringValue(run, ["childSessionId"]);
  if (!childSessionId) return undefined;
  const roleId = stringValue(run, ["roleId"]) ?? stringValue(data, ["roleId"]);
  const status = stringValue(run, ["status"]) ?? stringValue(data, ["status"]);
  return {
    sessionId: childSessionId,
    label: "Open conversation",
    ...(roleId ? { roleId } : {}),
    ...(status ? { status } : {}),
  };
}

export function activitySubagentMessage(
  item: RuntimeEvent,
): ActivityItem["subagentMessage"] | undefined {
  if (item.name !== "subagent.message") return undefined;
  const data = asRecord(item.data);
  const message = asRecord(data?.message);
  if (!message) return undefined;
  const messageId = stringValue(message, ["id"]);
  const kind = stringValue(message, ["kind"]);
  const fromRunId = stringValue(message, ["fromRunId"]);
  const body = stringValue(message, ["body"]);
  if (!messageId || !kind || !fromRunId || !body) return undefined;

  const delivery = asRecord(data?.delivery ?? message.delivery);
  const modelRef = asRecord(data?.modelRef);
  const modelProviderId = stringValue(modelRef, ["providerId"]);
  const modelId = stringValue(modelRef, ["modelId"]);
  const deliveredParentSessionId = stringValue(delivery, ["deliveredParentSessionId"]);
  const direction =
    deliveredParentSessionId === item.sessionId && !fromRunId.startsWith("parent:")
      ? "received"
      : "sent";
  const refs = Array.isArray(message.refs)
    ? message.refs.flatMap((value) => {
        const ref = asRecord(value);
        const refKind = stringValue(ref, ["kind"]);
        const refId = stringValue(ref, ["id"]);
        const refLabel = stringValue(ref, ["label"]);
        return refKind && refId && refLabel ? [{ kind: refKind, id: refId, label: refLabel }] : [];
      })
    : [];

  return {
    direction,
    summary: summarizeSubagentMessageBody(body),
    body,
    messageId,
    kind,
    fromRunId,
    toRunId: stringValue(message, ["toRunId"]),
    toRole: stringValue(message, ["toRole"]),
    childSessionId: stringValue(data, ["childSessionId"]),
    childTitle: stringValue(data, ["childSessionTitle"]),
    roleId: stringValue(data, ["roleId"]),
    modelRef: modelProviderId && modelId ? { providerId: modelProviderId, modelId } : null,
    deliveryStatus: stringValue(delivery, ["status"]),
    wakeReason: stringValue(delivery, ["wakeParentReason"]),
    createdAt: stringValue(message, ["createdAt"]),
    refs,
  };
}

function summarizeSubagentMessageBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "No message body";
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(normalized)?.[1] ?? normalized;
  return truncateActivitySummary(sentence, 96);
}

function truncateActivitySummary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, maxLength - 1);
  const boundary = sliced.lastIndexOf(" ");
  const end = boundary >= Math.floor(maxLength * 0.55) ? boundary : maxLength - 1;
  return `${sliced.slice(0, end).trimEnd()}...`;
}
