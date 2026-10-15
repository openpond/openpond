/** Codex app-server thread/goal protocol. Goal state remains owned by Codex. */
export type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type CodexThreadGoalPatch = {
  objective?: string;
  status?: "active" | "paused";
};
