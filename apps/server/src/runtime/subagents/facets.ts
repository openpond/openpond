import type { createGoalSubagentLifecycle } from "../goals/subagent-lifecycle.js";
import type { createSubagentContinuationRuntime } from "./continuation-runtime.js";
import type { createSubagentToolRuntime } from "./tool-runtime.js";
import type { createSubagentWorkspaceRuntime } from "./workspace-runtime.js";

export type SubagentToolHandlers = ReturnType<typeof createSubagentToolRuntime>;
export type SubagentTurnHooks = ReturnType<typeof createSubagentContinuationRuntime>;
export type SubagentLifecycleControl = ReturnType<typeof createSubagentWorkspaceRuntime>;
export type GoalSubagentPort = ReturnType<typeof createGoalSubagentLifecycle>;
