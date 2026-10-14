import type { ActivityItem, ChatMessage } from "./app-models";

export function latestActivityPlan(activities: ActivityItem[]): ActivityItem["plan"] {
  for (let index = activities.length - 1; index >= 0; index--) {
    if (activities[index]?.plan !== undefined) return activities[index]!.plan;
  }
  return undefined;
}

export function latestChatPlan(messages: ChatMessage[]): ActivityItem["plan"] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const plan = latestActivityPlan(messages[index]?.activities ?? []);
    if (plan !== undefined) return plan;
  }
  return undefined;
}
