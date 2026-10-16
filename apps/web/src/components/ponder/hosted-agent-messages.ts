import type { PonderHostedAssignment, PonderHostedAssignmentDetail, RuntimeEvent } from "@openpond/contracts";
import { buildChatMessages } from "../../lib/chat-messages";

/** Adapt the public Work progress contract to the normal chat projection, without creating a local session. */
export function hostedAgentMessages(assignment: PonderHostedAssignment, progress: PonderHostedAssignmentDetail["events"]) {
  const turnId = assignment.remoteTurnId ?? assignment.id;
  // Public progress has no execution timestamps. The ledger updatedAt is a refresh
  // time, so it must never become a message time or an apparent run duration.
  const base = {turnId, timestamp: "", source: "provider" as const};
  const events: RuntimeEvent[] = [{...base, id: `${assignment.id}:prompt`, name: "turn.started", timestamp: assignment.createdAt, args: {prompt: assignment.assignment}}];
  for (const event of progress) {
    if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
      if (event.text) events.push({...base, id: event.id, name: event.type, output: event.text});
    } else if (["tool.started", "tool.completed", "tool.failed"].includes(event.type)) {
      const action = /^([A-Za-z][A-Za-z0-9_.:-]{0,95}): (?:started|completed|failed|updated)$/.exec(event.text ?? "")?.[1];
      events.push({...base, id: event.id, name: event.type === "tool.started" ? "tool.started" : "tool.completed",
        action: action ?? "tool", status: event.type === "tool.started" ? "started" : event.type === "tool.failed" ? "failed" : "completed"});
    }
  }
  const terminal = ["completed", "failed", "cancelled"].includes(assignment.state);
  const result = assignment.resultText?.trim();
  if (terminal && result) {
    let lastDelta = -1, lastTool = -1;
    for (let index = 0; index < events.length; index++) {
      if (events[index]!.name === "assistant.delta") lastDelta = index;
      if (events[index]!.name === "tool.started" || events[index]!.name === "tool.completed") lastTool = index;
    }
    let firstDelta = lastDelta;
    while (firstDelta > 0 && events[firstDelta - 1]?.name === "assistant.delta") firstDelta--;
    const streamedAnswer = lastDelta < 0 ? "" : events.slice(firstDelta, lastDelta + 1).map(event => event.output ?? "").join("");
    // Replace the final streamed answer with the authoritative receipt. Earlier
    // dialogue stays in order; a missing final delta is restored after the tools.
    if (lastDelta >= 0 && (lastDelta > lastTool || streamedAnswer.trim() === result)) {
      events.splice(firstDelta, lastDelta - firstDelta + 1, {...base, id: events[firstDelta]!.id,
        name: "assistant.delta", output: result, timestamp: ""});
    } else events.push({...base, id: `${assignment.id}:result`, name: "assistant.delta", output: result, timestamp: ""});
  }
  if (terminal) events.push({...base, id: `${assignment.id}:terminal`,
    name: assignment.state === "failed" ? "turn.failed" : assignment.state === "cancelled" ? "turn.interrupted" : "turn.completed",
    timestamp: "", ...(assignment.error ? {error: assignment.error} : {})});
  return buildChatMessages(events);
}
