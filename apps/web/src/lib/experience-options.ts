import type { Experience } from "@openpond/contracts";

export const EXPERIENCE_OPTIONS: ReadonlyArray<{
  value: Experience;
  label: string;
  description: string;
}> = [
  {
    value: "chat",
    label: "Chat",
    description: "Questions, explanations, brainstorming, and short drafts",
  },
  {
    value: "work",
    label: "Work",
    description: "Multi-step tasks with reviewable results",
  },
  {
    value: "development",
    label: "Developer",
    description: "Projects, code, and developer tools",
  },
];

export function newExperienceTitle(experience: Experience): string {
  return experience === "chat" ? "New chat" : "New task";
}
