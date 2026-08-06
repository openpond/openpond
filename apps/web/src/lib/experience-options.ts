import type { Experience, ProductArea } from "@openpond/contracts";

export type ChatTaskMode = Extract<Experience, "chat" | "work">;

export const CHAT_TASK_MODE_OPTIONS: ReadonlyArray<{
  value: ChatTaskMode;
  label: string;
}> = [
  {
    value: "chat",
    label: "Chat",
  },
  {
    value: "work",
    label: "Work",
  },
];

export const PRODUCT_AREA_OPTIONS: ReadonlyArray<{
  value: ProductArea;
  label: string;
  description: string;
}> = [
  {
    value: "chat",
    label: "Chat",
    description: "Chat and complete tasks",
  },
  {
    value: "models",
    label: "Models",
    description: "Evaluate, train, and serve models",
  },
];

export function newExperienceTitle(experience: Experience): string {
  return experience === "chat" ? "New chat" : "New task";
}
