import {
  SubagentMessageDeliverySchema,
  SubagentMessageSchema,
  SubagentRunSchema,
  type RuntimeEvent,
  type Session,
  type SubagentRun,
} from "@openpond/contracts";

import { recordFromUnknown, truncateForModelAside } from "../turns/value-utils.js";
import { PARENT_MODEL_VISIBLE_SUBAGENT_EVENTS } from "./tool-loop-action-policy.js";

export function subagentModelAsideMessages(input: {
  session: Session;
  events: RuntimeEvent[];
  initialEventIds: Set<string>;
  deliveredKeys: Set<string>;
}): string[] {
  const messages: string[] = [];
  for (const item of input.events) {
    const key = subagentAsideEventKey(item);
    if (input.deliveredKeys.has(key)) continue;
    const content = input.session.subagentRunId
      ? childSubagentMailboxAside(input.session, item)
      : parentSubagentReceiptAside({
          session: input.session,
          event: item,
          initialEventIds: input.initialEventIds,
        });
    if (!content) continue;
    input.deliveredKeys.add(key);
    messages.push(content);
  }
  return messages;
}

function parentSubagentReceiptAside(input: {
  session: Session;
  event: RuntimeEvent;
  initialEventIds: Set<string>;
}): string | null {
  const item = input.event;
  if (item.sessionId !== input.session.id) return null;
  if (input.initialEventIds.has(item.id)) return null;
  if (!PARENT_MODEL_VISIBLE_SUBAGENT_EVENTS.has(item.name)) return null;
  if (item.name === "subagent.message") return parentSubagentMessageAside(input.session, item);
  const run = subagentRunFromRuntimeEvent(item);
  if (!run || run.parentSessionId !== input.session.id) return null;
  const report = run.report;
  return [
    "Subagent update:",
    `event: ${item.name}`,
    `run: ${run.id}`,
    `role: ${run.roleId}`,
    `status: ${run.status}`,
    run.childSessionId ? `child session: ${run.childSessionId}` : null,
    item.output ? `receipt: ${item.output}` : null,
    report?.summary ? `summary: ${truncateForModelAside(report.summary, 1200)}` : null,
    report?.blockers.length ? `blockers: ${report.blockers.slice(0, 4).join(" | ")}` : null,
    report?.testsRun.length ? `tests: ${report.testsRun.slice(0, 4).join(" | ")}` : null,
    report?.patchRef ? `patch: ${report.patchRef.kind}:${report.patchRef.id} (${report.patchRef.label})` : null,
    report?.diffRef ? `diff: ${report.diffRef.kind}:${report.diffRef.id} (${report.diffRef.label})` : null,
    "Use this pushed receipt. Do not poll unless you need a fresh diagnostic snapshot.",
  ].filter(Boolean).join("\n");
}

function parentSubagentMessageAside(session: Session, item: RuntimeEvent): string | null {
  const data = recordFromUnknown(item.data);
  const parsed = SubagentMessageSchema.safeParse(data?.message);
  if (!parsed.success) return null;
  const message = parsed.data;
  const delivery = SubagentMessageDeliverySchema.safeParse(data?.delivery ?? message.delivery).success
    ? SubagentMessageDeliverySchema.parse(data?.delivery ?? message.delivery)
    : null;
  if (delivery?.deliveredParentSessionId !== session.id) return null;
  return [
    "Subagent handoff:",
    `message: ${message.id}`,
    `kind: ${message.kind}`,
    `from: ${message.fromRunId}`,
    `body: ${truncateForModelAside(message.body, 4000)}`,
    message.refs.length
      ? `refs: ${message.refs.slice(0, 8).map((ref) => `${ref.kind}:${ref.id} (${ref.label})`).join(", ")}`
      : null,
    "This is the child's bounded final result. Decide what it means and what to do next; the runtime does not accept, reject, review, or advance work for you.",
  ].filter(Boolean).join("\n");
}

function childSubagentMailboxAside(session: Session, item: RuntimeEvent): string | null {
  if (item.sessionId !== session.id || item.name !== "subagent.message") return null;
  const data = recordFromUnknown(item.data);
  const parsed = SubagentMessageSchema.safeParse(data?.message);
  if (!parsed.success) return null;
  const message = parsed.data;
  const deliveredToRunId = typeof data?.deliveredToRunId === "string" ? data.deliveredToRunId : null;
  if (deliveredToRunId && session.subagentRunId && deliveredToRunId !== session.subagentRunId) return null;
  const priority = message.priority ?? "normal";
  return [
    `Subagent mailbox ${priority === "interrupt" ? "interrupt" : "update"}:`,
    `message: ${message.id}`,
    `kind: ${message.kind}`,
    `from: ${message.fromRunId}`,
    message.toRunId ? `to run: ${message.toRunId}` : null,
    message.toRole ? `to role: ${message.toRole}` : null,
    `body: ${truncateForModelAside(message.body, 2000)}`,
    message.refs.length
      ? `refs: ${message.refs.slice(0, 8).map((ref) => `${ref.kind}:${ref.id} (${ref.label})`).join(", ")}`
      : null,
    priority === "interrupt"
      ? "Treat this as high-priority steering at this safe model boundary."
      : "Use this message as goal-scoped coordination context.",
  ].filter(Boolean).join("\n");
}

function subagentRunFromRuntimeEvent(item: RuntimeEvent): SubagentRun | null {
  const data = recordFromUnknown(item.data);
  const parsed = SubagentRunSchema.safeParse(data?.run);
  return parsed.success ? parsed.data : null;
}

function subagentAsideEventKey(item: RuntimeEvent): string {
  return typeof item.sequence === "number" ? `seq:${item.sequence}` : `id:${item.id}`;
}
