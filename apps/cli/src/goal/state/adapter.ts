import type {
  GoalAnswer,
  GoalEvent,
  GoalQuestion,
  GoalRunResult,
  GoalState,
} from "../types";

export interface GoalStateAdapter {
  create(goal: GoalState): Promise<GoalState>;
  get(goalId: string): Promise<GoalState | null>;
  update(goal: GoalState): Promise<GoalState>;
  appendEvent(goalId: string, event: GoalEvent): Promise<GoalState>;
  addQuestion(goalId: string, question: GoalQuestion): Promise<GoalState>;
  answerQuestion(params: {
    goalId: string;
    questionId: string;
    answer: GoalAnswer;
  }): Promise<GoalState>;
  writeResult?(goalId: string, result: GoalRunResult): Promise<void>;
}
