import type { RuntimeEvent } from "@openpond/contracts";

import { asRecord } from "./chat-message-utils";

type CodexControlMessage = {
  kind: "goal_context" | "turn_aborted";
  text: string;
};

export function codexControlMessage(content: string): CodexControlMessage | null {
  const trimmed = content.trim();
  const match = /^<(goal_context|turn_aborted)>\s*([\s\S]*?)\s*<\/\1>$/.exec(
    trimmed,
  );
  if (match) {
    const kind = match[1] as CodexControlMessage["kind"];
    return {
      kind,
      text: match[2]?.trim() || defaultCodexControlText(kind),
    };
  }
  if (trimmed === "<turn_aborted>") {
    return {
      kind: "turn_aborted",
      text: defaultCodexControlText("turn_aborted"),
    };
  }
  if (trimmed === "<goal_context>") {
    return {
      kind: "goal_context",
      text: defaultCodexControlText("goal_context"),
    };
  }
  return null;
}

function defaultCodexControlText(kind: CodexControlMessage["kind"]): string {
  return kind === "turn_aborted"
    ? "The previous turn was interrupted."
    : "Goal context updated.";
}

export function isCodexGoalContextEvent(item: RuntimeEvent): boolean {
  return (
    item.name === "diagnostic" && asRecord(item.data)?.kind === "goal_context"
  );
}
