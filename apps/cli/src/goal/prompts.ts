import type { GoalState } from "./types";

export type GoalPromptPack = {
  id: string;
  title: string;
  instructions: string;
};

const GENERIC_CODING_PROMPT = `# Generic Coding Goal

You are working on a source-backed coding goal. Make scoped source edits, run the configured checks, ask structured questions when blocked, and return a reviewable result.`;

export function resolveGoalPromptPack(goal: GoalState): GoalPromptPack {
  return {
    id: goal.promptPack || "generic_coding_v1",
    title: "Generic Coding Goal",
    instructions: GENERIC_CODING_PROMPT,
  };
}
