import { randomUUID } from "node:crypto";

import type { GoalEvent, GoalEventKind } from "./types";
import type { GoalStateAdapter } from "./state/adapter";
import type { HostedGoalClient } from "./state/hosted";

export function createGoalEvent(input: {
  goalId: string;
  iterationId?: string | null;
  kind: GoalEventKind;
  summary: string;
  payload?: Record<string, unknown>;
}): GoalEvent {
  return {
    id: `event_${randomUUID()}`,
    goalId: input.goalId,
    iterationId: input.iterationId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload ?? {},
    createdAt: new Date().toISOString(),
  };
}

export function serializeGoalEventRecord(event: GoalEvent): string {
  return JSON.stringify(event);
}

export async function recordGoalEvent(
  event: GoalEvent,
  targets: {
    localState?: GoalStateAdapter | null;
    hostedClient?: HostedGoalClient | null;
  }
): Promise<void> {
  await targets.localState?.appendEvent(event.goalId, event);
  await targets.hostedClient?.appendEvent(event.goalId, event);
}
