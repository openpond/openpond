import type { DesktopHarnessScenarioDefinition } from "./types.js";

export function desktopScenario(
  definition: DesktopHarnessScenarioDefinition,
): DesktopHarnessScenarioDefinition {
  if (!definition.name.trim()) throw new Error("Desktop harness scenario name is required.");
  return definition;
}
