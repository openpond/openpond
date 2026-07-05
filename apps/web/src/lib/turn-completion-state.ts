import type { RuntimeEvent } from "@openpond/contracts";

export type TurnCompletionState = "blocked" | "completed" | "none" | "pending";

function isTerminalTurnEvent(event: RuntimeEvent): boolean {
  return event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted";
}

export function latestTurnCompletionState(events: RuntimeEvent[]): TurnCompletionState {
  let startedIndex = -1;
  let startedTurnId: string | null = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "turn.started") continue;
    startedIndex = index;
    startedTurnId = event.turnId ?? null;
    break;
  }

  if (startedIndex === -1) return "none";

  for (let index = events.length - 1; index > startedIndex; index -= 1) {
    const event = events[index];
    if (!event || !isTerminalTurnEvent(event)) continue;
    if (startedTurnId && event.turnId && event.turnId !== startedTurnId) continue;
    return event.name === "turn.completed" ? "completed" : "blocked";
  }

  return "pending";
}
