import { GENERIC_CODING_PROFILE, type GoalProfileDescriptor } from "./generic-coding";
import { OPENPOND_AGENT_PROFILE } from "./openpond-agent";
import type { GoalState } from "../types";

export function getGoalProfileDescriptor(
  goal: GoalState
): GoalProfileDescriptor {
  if (goal.profile === "openpond_agent") {
    return {
      ...OPENPOND_AGENT_PROFILE,
      promptPack: goal.promptPack,
    };
  }
  return {
    ...GENERIC_CODING_PROFILE,
    promptPack: goal.promptPack,
  };
}
