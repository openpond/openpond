import type { Experience, ProductArea } from "@openpond/contracts";

/** The desktop has one capability surface; repository sessions retain their context. */
export function desktopExperience(experience: Experience): "work" | "development" {
  return experience === "development" ? "development" : "work";
}

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
  {
    value: "console",
    label: "Console",
    description: "Manage models and workspace resources",
  },
];

export function newExperienceTitle(_experience: Experience): string {
  return "New thread";
}
