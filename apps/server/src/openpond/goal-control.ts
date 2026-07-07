import { randomUUID } from "node:crypto";
import {
  normalizeOpenPondGoalStatus,
  type OpenPondGoalStatus,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { resolveWorkspaceExecutionTarget } from "../workspace/workspace-execution-target.js";

export type OpenPondGoalControlAction = "start" | "restart" | "pause" | "resume" | "complete" | "stop";
export type OpenPondGoalControlMode = "local" | "remote" | "auto";
export type ResolvedOpenPondGoalControlMode = Exclude<OpenPondGoalControlMode, "auto">;

export type OpenPondGoalControlInput = {
  action: OpenPondGoalControlAction;
  objective?: string | null;
  targetGoalId?: string | null;
  mode?: OpenPondGoalControlMode | null;
  reason: string;
};

export type OpenPondGoalControlGoal = {
  id: string;
  provider: "openpond";
  status: OpenPondGoalStatus;
  objective: string;
  mode: ResolvedOpenPondGoalControlMode;
  reason: string;
  controlAction: OpenPondGoalControlAction;
  previousStatus: string | null;
  source: "model_tool";
  createdAt: string;
  updatedAt: string;
  restartedFromGoalId?: string | null;
  targetGoalId?: string | null;
  timeUsedSeconds?: number;
  tokensUsed?: number | null;
  tokenBudget?: number | null;
};

export type OpenPondGoalControlResult = {
  action: OpenPondGoalControlAction;
  goal: OpenPondGoalControlGoal;
  previousGoal: Record<string, unknown> | null;
  mode: ResolvedOpenPondGoalControlMode;
  status: OpenPondGoalStatus;
  nextStep: string;
};

export function runOpenPondGoalControl(input: {
  session: Session;
  events: readonly RuntimeEvent[];
  request: OpenPondGoalControlInput;
  now?: string;
}): OpenPondGoalControlResult {
  const action = input.request.action;
  const reason = cleanRequired(input.request.reason, "reason");
  const targetGoalId = cleanOptional(input.request.targetGoalId);
  const targetGoal = targetGoalId
    ? findOpenPondGoalById(input.events, input.session.id, targetGoalId)
    : latestOpenPondGoal(input.events, input.session.id);
  const now = input.now ?? new Date().toISOString();
  const mode = resolveGoalControlMode({
    session: input.session,
    requestedMode: input.request.mode ?? "auto",
    targetGoal,
  });
  const previousStatus = stringValue(targetGoal?.status);
  const normalizedPreviousStatus = normalizeOpenPondGoalStatus(previousStatus);

  if (action === "start") {
    const objective = cleanRequired(input.request.objective, "objective");
    const goal = createControlledGoal({
      id: `goal_${randomUUID()}`,
      action,
      objective,
      reason,
      mode,
      status: "queued",
      targetGoal: null,
      previousStatus: null,
      now,
    });
    return controlResult({ action, goal, previousGoal: null, nextStep: "OpenPond goal queued." });
  }

  if (!targetGoal) {
    throw new Error("No current OpenPond goal was found. Ask the user which goal to control, or start a new goal with an objective.");
  }
  if (isProfileSkillGoal(targetGoal)) {
    throw new Error(
      "Profile skill goals cannot be controlled with generic goal control yet. Let the profile skill creation or edit finish, or start a new profile skill request.",
    );
  }

  const objective = cleanOptional(input.request.objective) ?? stringValue(targetGoal.objective) ?? "OpenPond goal";
  if (action === "restart") {
    const goal = createControlledGoal({
      id: stringValue(targetGoal.id) ?? `goal_${randomUUID()}`,
      action,
      objective,
      reason,
      mode,
      status: "queued",
      targetGoal,
      previousStatus,
      now,
      restartedFromGoalId: stringValue(targetGoal.id),
    });
    return controlResult({ action, goal, previousGoal: targetGoal, nextStep: "OpenPond goal restarted." });
  }

  if (action === "pause") {
    assertTransitionAllowed(action, normalizedPreviousStatus);
    const goal = createControlledGoal({
      id: stringValue(targetGoal.id) ?? `goal_${randomUUID()}`,
      action,
      objective,
      reason,
      mode,
      status: "paused",
      targetGoal,
      previousStatus,
      now,
    });
    return controlResult({ action, goal, previousGoal: targetGoal, nextStep: "OpenPond goal paused." });
  }

  if (action === "resume") {
    assertTransitionAllowed(action, normalizedPreviousStatus);
    const goal = createControlledGoal({
      id: stringValue(targetGoal.id) ?? `goal_${randomUUID()}`,
      action,
      objective,
      reason,
      mode,
      status: "queued",
      targetGoal,
      previousStatus,
      now,
    });
    return controlResult({ action, goal, previousGoal: targetGoal, nextStep: "OpenPond goal resumed." });
  }

  if (action === "complete") {
    assertTransitionAllowed(action, normalizedPreviousStatus);
    const goal = createControlledGoal({
      id: stringValue(targetGoal.id) ?? `goal_${randomUUID()}`,
      action,
      objective,
      reason,
      mode,
      status: "completed",
      targetGoal,
      previousStatus,
      now,
    });
    return controlResult({ action, goal, previousGoal: targetGoal, nextStep: "OpenPond goal completed." });
  }

  const goal = createControlledGoal({
    id: stringValue(targetGoal.id) ?? `goal_${randomUUID()}`,
    action,
    objective,
    reason,
    mode,
    status: "cancelled",
    targetGoal,
    previousStatus,
    now,
  });
  return controlResult({ action, goal, previousGoal: targetGoal, nextStep: "OpenPond goal stopped." });
}

function controlResult(input: {
  action: OpenPondGoalControlAction;
  goal: OpenPondGoalControlGoal;
  previousGoal: Record<string, unknown> | null;
  nextStep: string;
}): OpenPondGoalControlResult {
  return {
    action: input.action,
    goal: input.goal,
    previousGoal: input.previousGoal,
    mode: input.goal.mode,
    status: input.goal.status,
    nextStep: input.nextStep,
  };
}

function createControlledGoal(input: {
  id: string;
  action: OpenPondGoalControlAction;
  objective: string;
  reason: string;
  mode: ResolvedOpenPondGoalControlMode;
  status: OpenPondGoalStatus;
  targetGoal: Record<string, unknown> | null;
  previousStatus: string | null;
  now: string;
  restartedFromGoalId?: string | null;
}): OpenPondGoalControlGoal {
  return {
    id: input.id,
    provider: "openpond",
    status: input.status,
    objective: input.objective,
    mode: input.mode,
    reason: input.reason,
    controlAction: input.action,
    previousStatus: input.previousStatus,
    source: "model_tool",
    createdAt: stringValue(input.targetGoal?.createdAt) ?? input.now,
    updatedAt: input.now,
    targetGoalId: stringValue(input.targetGoal?.id),
    restartedFromGoalId: input.restartedFromGoalId,
    ...preservedUsage(input.targetGoal),
  };
}

function preservedUsage(goal: Record<string, unknown> | null): Pick<
  OpenPondGoalControlGoal,
  "timeUsedSeconds" | "tokensUsed" | "tokenBudget"
> {
  const timeUsedSeconds = numberValue(goal?.timeUsedSeconds) ?? numberValue(goal?.time_used_seconds);
  const tokensUsed = numberValue(goal?.tokensUsed) ?? numberValue(goal?.tokens_used);
  const tokenBudget = numberValue(goal?.tokenBudget) ?? numberValue(goal?.token_budget);
  return {
    ...(timeUsedSeconds !== null ? { timeUsedSeconds } : {}),
    ...(tokensUsed !== null ? { tokensUsed } : {}),
    ...(tokenBudget !== null ? { tokenBudget } : {}),
  };
}

function assertTransitionAllowed(
  action: "pause" | "resume" | "complete",
  previousStatus: OpenPondGoalStatus | null,
): void {
  if (!previousStatus) return;
  if (action === "pause" && ["completed", "failed", "cancelled"].includes(previousStatus)) {
    throw new Error(`Cannot pause a ${previousStatus} OpenPond goal. Restart it instead.`);
  }
  if (action === "resume" && ["queued", "running", "awaiting_user_input", "awaiting_approval"].includes(previousStatus)) {
    throw new Error(`OpenPond goal is already ${previousStatus}.`);
  }
  if (action === "resume" && ["completed", "failed", "cancelled"].includes(previousStatus)) {
    throw new Error(`Cannot resume a ${previousStatus} OpenPond goal. Restart it instead.`);
  }
  if (action === "complete" && ["completed", "failed", "cancelled"].includes(previousStatus)) {
    throw new Error(`Cannot complete a ${previousStatus} OpenPond goal. Restart it instead.`);
  }
}

function resolveGoalControlMode(input: {
  session: Session;
  requestedMode: OpenPondGoalControlMode;
  targetGoal: Record<string, unknown> | null;
}): ResolvedOpenPondGoalControlMode {
  if (input.requestedMode === "local" || input.requestedMode === "remote") return input.requestedMode;
  const goalMode = stringValue(input.targetGoal?.mode);
  if (goalMode === "local" || goalMode === "remote") return goalMode;
  const executionTarget = resolveWorkspaceExecutionTarget({ session: input.session });
  if (executionTarget.target === "sandbox") return "remote";
  if (executionTarget.target === "local") return "local";
  if (input.session.cloudProjectId || input.session.cloudTeamId) return "remote";
  throw new Error("OpenPond goal control needs a local or remote workspace context. Ask which execution mode to use.");
}

function latestOpenPondGoal(
  events: readonly RuntimeEvent[],
  sessionId: string,
): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.sessionId !== sessionId) continue;
    const data = asRecord(event.data);
    if (data?.kind === "thread_goal_cleared" && openPondProvider(data, null)) return null;
    if (event?.name !== "diagnostic" || data?.kind !== "thread_goal") continue;
    const goal = asRecord(data.goal);
    if (!goal || !openPondProvider(data, goal)) continue;
    return goal;
  }
  return null;
}

function findOpenPondGoalById(
  events: readonly RuntimeEvent[],
  sessionId: string,
  goalId: string,
): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.sessionId !== sessionId) continue;
    const data = asRecord(event.data);
    if (event?.name !== "diagnostic" || data?.kind !== "thread_goal") continue;
    const goal = asRecord(data.goal);
    if (!goal || !openPondProvider(data, goal) || stringValue(goal.id) !== goalId) continue;
    return goal;
  }
  return null;
}

function openPondProvider(data: Record<string, unknown>, goal: Record<string, unknown> | null): boolean {
  const provider = stringValue(data.provider) ?? stringValue(goal?.provider) ?? "openpond";
  return provider === "openpond";
}

function isProfileSkillGoal(goal: Record<string, unknown>): boolean {
  const kind = stringValue(goal.kind);
  return kind === "profile_skill_create" || kind === "profile_skill_edit";
}

function cleanRequired(value: string | null | undefined, name: string): string {
  const cleaned = cleanOptional(value);
  if (!cleaned) throw new Error(`${name} is required`);
  return cleaned;
}

function cleanOptional(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
