import type { ActivityItem, ChatMessage } from "./app-models";

export function latestActivityPlan(activities: ActivityItem[]): ActivityItem["plan"] {
  for (let index = activities.length - 1; index >= 0; index--) {
    if (activities[index]?.plan !== undefined) return activities[index]!.plan;
  }
  return undefined;
}

export type ChatTaskProgress = {
  scopeKey: string;
  entries: NonNullable<ActivityItem["plan"]>;
  messageIds: ReadonlySet<string>;
};

/** A fresh request must not inherit the previous task's checklist. Steering
 * continues the current task, including its earlier plan snapshots. */
export function currentChatTaskProgress(messages: ChatMessage[]): ChatTaskProgress | null {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && message.interactionKind !== "steer") {
      start = index;
      break;
    }
  }
  let entries: ActivityItem["plan"];
  const messageIds = new Set<string>();
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    const plan = latestActivityPlan(message.activities ?? []);
    if (plan !== undefined) {
      entries = plan;
      messageIds.add(message.id);
    }
  }
  return entries?.length ? { scopeKey: messages[start]!.id, entries, messageIds } : null;
}
