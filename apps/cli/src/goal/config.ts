import { randomUUID } from "node:crypto";
import os from "node:os";
import { join, resolve } from "node:path";
import { loadGlobalConfig, type LocalGoalStorageLocation } from "@openpond/cloud/config";

import type {
  GoalBudget,
  GoalExecutionPolicy,
  GoalKind,
  GoalProfile,
  GoalState,
  GoalVerification,
} from "./types";

export const DEFAULT_GOAL_EXECUTION_POLICY: GoalExecutionPolicy = {
  sourceUpdates: "auto_commit_push_default_branch",
  externalEffects: "approval_required",
  budgetEscalation: "approval_required",
};

export const DEFAULT_GOAL_VERIFICATION: GoalVerification = {
  commands: [],
  requiredChecks: [],
  successCriteria: [],
  regressionPolicy: "existing_checks_must_pass",
  artifactRefs: [],
};

export const DEFAULT_GOAL_BUDGET: GoalBudget = {
  maxIterations: 8,
  maxRuntimeMinutes: 60,
  maxModelCostUsd: null,
};

export function goalKindDefaultProfile(kind: GoalKind): GoalProfile {
  return kind === "create_agent" || kind === "update_agent"
    ? "openpond_agent"
    : "generic_coding";
}

export function defaultPromptPackForGoal(kind: GoalKind): string {
  if (kind === "create_agent") return "openpond_agent_create_v1";
  if (kind === "update_agent") return "openpond_agent_update_v1";
  return "generic_coding_v1";
}

export function createGoalState(input: {
  objective: string;
  kind?: GoalKind;
  profile?: GoalProfile;
  promptPack?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  workItemId?: string | null;
  conversationId?: string | null;
  verification?: Partial<GoalVerification> | null;
}): GoalState {
  const kind = input.kind ?? "general_code_goal";
  const profile = input.profile ?? goalKindDefaultProfile(kind);
  const now = new Date().toISOString();
  return {
    id: `goal_${randomUUID()}`,
    teamId: input.teamId ?? null,
    projectId: input.projectId ?? null,
    agentId: input.agentId ?? null,
    workItemId: input.workItemId ?? null,
    conversationId: input.conversationId ?? null,
    sandboxId: null,
    runtimeId: null,
    kind,
    profile,
    promptPack: input.promptPack ?? defaultPromptPackForGoal(kind),
    objective: input.objective,
    status: "queued",
    executionPolicy: DEFAULT_GOAL_EXECUTION_POLICY,
    verification: {
      ...DEFAULT_GOAL_VERIFICATION,
      ...(input.verification ?? {}),
      commands:
        input.verification?.commands ?? DEFAULT_GOAL_VERIFICATION.commands,
      requiredChecks:
        input.verification?.requiredChecks ??
        DEFAULT_GOAL_VERIFICATION.requiredChecks,
      successCriteria:
        input.verification?.successCriteria ??
        DEFAULT_GOAL_VERIFICATION.successCriteria,
      artifactRefs:
        input.verification?.artifactRefs ??
        DEFAULT_GOAL_VERIFICATION.artifactRefs,
    },
    constraints: [],
    evidenceRefs: [],
    budget: DEFAULT_GOAL_BUDGET,
    questions: [],
    answers: [],
    approvals: [],
    events: [
      {
        id: `event_${randomUUID()}`,
        goalId: "",
        iterationId: null,
        kind: "goal.created",
        summary: "Goal created",
        payload: { kind, profile },
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeGoalState(state: GoalState): GoalState {
  return {
    ...state,
    events: state.events.map((event) =>
      event.goalId ? event : { ...event, goalId: state.id }
    ),
  };
}

export function resolveGoalWorkspace(cwd?: string | null): string {
  return resolve(cwd || process.cwd());
}

export type GoalStorageLocation = LocalGoalStorageLocation;

export const DEFAULT_GOAL_STORAGE_LOCATION: GoalStorageLocation = "global";

export function parseGoalStorageLocation(value?: string | null): GoalStorageLocation | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "global" || normalized === "home" || normalized === "user-home") return "global";
  if (normalized === "workspace" || normalized === "cwd" || normalized === "working-directory") return "workspace";
  throw new Error("goal storage must be global or workspace");
}

export async function resolveGoalStorageLocation(explicit?: string | null): Promise<GoalStorageLocation> {
  const explicitLocation = parseGoalStorageLocation(explicit);
  if (explicitLocation) return explicitLocation;
  const envLocation = parseGoalStorageLocation(
    process.env.OPENPOND_GOAL_STORAGE_LOCATION || process.env.OPENPOND_GOAL_STORAGE
  );
  if (envLocation) return envLocation;
  const config = await loadGlobalConfig().catch(() => null);
  return config?.goalStorageLocation ?? DEFAULT_GOAL_STORAGE_LOCATION;
}

export function resolveGoalStorageRoot(input: {
  cwd?: string | null;
  location: GoalStorageLocation;
}): string {
  return input.location === "workspace" ? resolveGoalWorkspace(input.cwd) : os.homedir();
}

export function goalStateDisplayPath(input: {
  storageRoot: string;
  goalId: string;
  fileName: string;
}): string {
  const home = os.homedir();
  const relative = join(".openpond", "goals", input.goalId, input.fileName);
  return input.storageRoot === home ? `~/${relative}` : relative;
}
