import { GENERIC_CODING_PROFILE, type GoalProfileDescriptor } from "./generic-coding";
import type { GoalState } from "../types";

export function getGoalProfileDescriptor(
  goal: GoalState
): GoalProfileDescriptor {
  return {
    ...GENERIC_CODING_PROFILE,
    promptPack: goal.promptPack,
  };
}
