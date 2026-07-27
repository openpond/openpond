import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createGoalState,
  goalStateDisplayPath,
  normalizeGoalState,
  resolveGoalStorageLocation,
  resolveGoalStorageRoot,
  resolveGoalWorkspace,
} from "./config";
import { createGoalEvent } from "./events";
import { runGoalIteration } from "./runner";
import { LocalGoalStateAdapter } from "./state/local";
import {
  HostedGoalClient,
  resolveHostedGoalApiUrl,
  resolveHostedGoalCredential,
} from "./state/hosted";
import type { GoalAnswer, GoalApproval, GoalKind, GoalState, GoalStatus } from "./types";

type GoalOutputMode = "json" | "jsonl";

const DEFAULT_HOSTED_GOAL_LAUNCH_PATH = "/run/openpond/goal-run.json";

type HostedGoalLaunchConfig = {
  goalId?: string;
  iterationId?: string;
  output?: { mode?: unknown };
};

export function printGoalHelp(): void {
  console.log("OpenPond Goal commands");
  console.log("");
  console.log("Usage:");
  console.log('  openpond goal "<objective>" [--cwd <path>] [--goal-storage global|workspace]');
  console.log("  openpond goal run --goal-id <id> [--cwd <path>] [--goal-storage global|workspace]");
  console.log(
    "  openpond goal answer <question-id> --choice <choice-id>|--answer <text> [--goal-id <id>] [--cwd <path>] [--goal-storage global|workspace]"
  );
  console.log("  openpond goal approve <goal-id> [--note <text>]");
  console.log("  openpond goal reject <goal-id> [--note <text>]");
  console.log("  openpond goal pause <goal-id>");
  console.log("  openpond goal resume <goal-id>");
  console.log("  openpond goal cancel <goal-id>");
  console.log("");
  console.log("Hosted env:");
  console.log("  OPENPOND_GOAL_API_KEY");
  console.log("  OPENPOND_GOAL_API_URL");
  console.log("  OPENPOND_GOAL_ID");
  console.log("  OPENPOND_GOAL_OUTPUT=jsonl");
}

function optionString(
  options: Record<string, string | boolean>,
  key: string
): string {
  const value = options[key];
  return typeof value === "string" ? value.trim() : "";
}

function hasFlag(
  options: Record<string, string | boolean>,
  key: string
): boolean {
  const value = options[key];
  return value === true || value === "true";
}

function requireOption(
  options: Record<string, string | boolean>,
  key: string,
  usage: string
): string {
  const value = optionString(options, key);
  if (!value) throw new Error(usage);
  return value;
}

function objectiveFromRest(rest: string[], usage: string): string {
  const objective = rest.join(" ").trim();
  if (!objective) throw new Error(usage);
  return objective;
}

function arrayOption(
  options: Record<string, string | boolean>,
  key: string
): string[] {
  const value = optionString(options, key);
  return value ? [value] : [];
}

async function localGoalPaths(options: Record<string, string | boolean>) {
  const cwd = optionString(options, "cwd");
  const workspace = resolveGoalWorkspace(cwd);
  const storageLocation = await resolveGoalStorageLocation(optionString(options, "goalStorage"));
  const storageRoot = resolveGoalStorageRoot({ cwd, location: storageLocation });
  return {
    workspace,
    storageRoot,
    storageLocation,
    adapter: new LocalGoalStateAdapter(storageRoot),
  };
}

async function readHostedGoalLaunchConfig(): Promise<HostedGoalLaunchConfig | null> {
  const launchPath =
    process.env.OPENPOND_GOAL_RUN_CONFIG_PATH?.trim() ||
    DEFAULT_HOSTED_GOAL_LAUNCH_PATH;
  try {
    return JSON.parse(await readFile(launchPath, "utf8")) as HostedGoalLaunchConfig;
  } catch {
    return null;
  }
}

async function resolveGoalOutputMode(params: {
  options: Record<string, string | boolean>;
  launchConfig?: HostedGoalLaunchConfig | null;
}): Promise<GoalOutputMode> {
  if (hasFlag(params.options, "jsonl") || optionString(params.options, "output") === "jsonl") {
    return "jsonl";
  }
  const explicit = process.env.OPENPOND_GOAL_OUTPUT?.trim();
  if (explicit === "jsonl") return "jsonl";
  return params.launchConfig?.output?.mode === "jsonl" ? "jsonl" : "json";
}

function printGoalRunOutput(
  result: Awaited<ReturnType<typeof runGoalIteration>>,
  mode: GoalOutputMode
) {
  if (mode !== "jsonl") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const event of result.events) {
    console.log(JSON.stringify({ type: "goal_event", event }));
  }
  console.log(JSON.stringify({ type: "goal_result", result }));
}

export async function createLocalGoal(params: {
  options: Record<string, string | boolean>;
  objective: string;
  kind: GoalKind;
}): Promise<GoalState> {
  const local = await localGoalPaths(params.options);
  let state = normalizeGoalState(
    createGoalState({
      objective: params.objective,
      kind: params.kind,
      teamId: optionString(params.options, "teamId") || null,
      projectId: optionString(params.options, "projectId") || null,
      agentId: optionString(params.options, "agentId") || null,
      workItemId: optionString(params.options, "workItemId") || null,
      conversationId: optionString(params.options, "conversationId") || null,
      verification: {
        commands: arrayOption(params.options, "verify"),
        successCriteria: arrayOption(params.options, "successCriteria"),
      },
    })
  );
  await local.adapter.create(state);
  console.log(`Goal created: ${state.id}`);
  console.log(`State: ${goalStateDisplayPath({ storageRoot: local.storageRoot, goalId: state.id, fileName: "state.json" })}`);
  return state;
}

async function runGoal(params: {
  options: Record<string, string | boolean>;
  goalId: string;
}) {
  const launchConfig = await readHostedGoalLaunchConfig();
  const outputMode = await resolveGoalOutputMode({
    options: params.options,
    launchConfig,
  });
  const credential = resolveHostedGoalCredential();
  const apiUrl = resolveHostedGoalApiUrl();
  if (credential && apiUrl) {
    const hosted = new HostedGoalClient(apiUrl, credential);
    const config = await hosted.getRunConfig(params.goalId);
    const result = await runGoalIteration({
      config: {
        ...config,
        iterationId: launchConfig?.iterationId ?? config.iterationId ?? null,
      },
      hostedClient: hosted,
    });
    printGoalRunOutput(result, outputMode);
    return;
  }

  const local = await localGoalPaths(params.options);
  const goal = await local.adapter.get(params.goalId);
  if (!goal) throw new Error(`goal not found: ${params.goalId}`);
  const result = await runGoalIteration({
    config: {
      goal,
      mode: "local",
      workspace: local.workspace,
      storageRoot: local.storageRoot,
      iterationId: null,
    },
    localState: local.adapter,
  });
  printGoalRunOutput(result, outputMode);
}

async function answerGoal(params: {
  options: Record<string, string | boolean>;
  questionId: string;
}) {
  const optionId = optionString(params.options, "choice") || null;
  const freeformText = optionString(params.options, "answer") || null;
  if (!optionId && !freeformText) {
    throw new Error("usage: goal answer <question-id> --choice <id>|--answer <text>");
  }

  const goalId = optionString(params.options, "goalId");
  const answer: GoalAnswer = {
    id: `answer_${randomUUID()}`,
    goalId,
    questionId: params.questionId,
    optionId,
    freeformText,
    value: {},
    createdAt: new Date().toISOString(),
  };

  const credential = resolveHostedGoalCredential();
  const apiUrl = resolveHostedGoalApiUrl();
  if (credential && apiUrl) {
    if (!goalId) {
      throw new Error("hosted goal answer requires --goal-id <goal-id>");
    }
    await new HostedGoalClient(apiUrl, credential).answerQuestion({
      goalId,
      questionId: params.questionId,
      answer,
    });
    console.log(`Answered question: ${params.questionId}`);
    return;
  }

  const local = await localGoalPaths(params.options);
  const goal = goalId
    ? await local.adapter.get(goalId)
    : await local.adapter.findGoalByQuestionId(params.questionId);
  if (!goal) throw new Error(`goal not found for question: ${params.questionId}`);
  await local.adapter.answerQuestion({
    goalId: goal.id,
    questionId: params.questionId,
    answer: { ...answer, goalId: goal.id },
  });
  console.log(`Answered question: ${params.questionId}`);
}

async function updateGoalStatus(params: {
  options: Record<string, string | boolean>;
  goalId: string;
  status: GoalStatus;
}) {
  const credential = resolveHostedGoalCredential();
  const apiUrl = resolveHostedGoalApiUrl();
  if (credential && apiUrl) {
    await new HostedGoalClient(apiUrl, credential).updateStatus(
      params.goalId,
      params.status
    );
    console.log(`Goal ${params.goalId} ${params.status}`);
    return;
  }

  const local = await localGoalPaths(params.options);
  const goal = await local.adapter.get(params.goalId);
  if (!goal) throw new Error(`goal not found: ${params.goalId}`);
  await local.adapter.update({ ...goal, status: params.status });
  await local.adapter.appendEvent(
    goal.id,
    createGoalEvent({
      goalId: goal.id,
      kind: "goal.status_changed",
      summary: `Goal ${params.status}`,
      payload: {
        fromStatus: goal.status,
        toStatus: params.status,
      },
    })
  );
  console.log(`Goal ${params.goalId} ${params.status}`);
}

async function applyGoalLifecycle(params: {
  options: Record<string, string | boolean>;
  goalId: string;
  action: "approve" | "reject" | "pause" | "resume" | "cancel";
}) {
  const credential = resolveHostedGoalCredential();
  const apiUrl = resolveHostedGoalApiUrl();
  if (credential && apiUrl) {
    const client = new HostedGoalClient(apiUrl, credential);
    if (params.action === "approve") {
      await client.approve(params.goalId, optionString(params.options, "note"));
    } else if (params.action === "reject") {
      await client.reject(params.goalId, optionString(params.options, "note"));
    } else if (params.action === "pause") {
      await client.pause(params.goalId);
    } else if (params.action === "resume") {
      await client.resume(params.goalId);
    } else {
      await client.cancel(params.goalId);
    }
    const completedAction = {
      approve: "approved",
      reject: "rejected",
      pause: "paused",
      resume: "resumed",
      cancel: "cancelled",
    } as const;
    console.log(`Goal ${params.goalId} ${completedAction[params.action]}`);
    return;
  }

  const statusByCommand = {
    pause: "paused",
    resume: "queued",
    cancel: "cancelled",
  } as const;
  if (
    params.action === "approve" ||
    params.action === "reject" ||
    params.action === "cancel"
  ) {
    const local = await localGoalPaths(params.options);
    const goal = await local.adapter.get(params.goalId);
    if (!goal) throw new Error(`goal not found: ${params.goalId}`);
    const now = new Date().toISOString();
    const note = optionString(params.options, "note") || null;
    const pendingApproval = goal.approvals.find(
      (approval) => approval.status === "pending"
    );
    if (!pendingApproval && params.action === "cancel") {
      await updateGoalStatus({
        options: params.options,
        goalId: params.goalId,
        status: "cancelled",
      });
      return;
    }
    if (!pendingApproval) {
      throw new Error(`goal has no pending approval: ${params.goalId}`);
    }
    const approvalStatus: GoalApproval["status"] =
      params.action === "approve"
        ? "approved"
        : params.action === "reject"
          ? "rejected"
          : "cancelled";
    const goalStatus: GoalStatus =
      params.action === "approve"
        ? "queued"
        : params.action === "reject"
          ? "blocked"
          : "cancelled";
    const approvals = goal.approvals.map((approval) =>
      approval.id === pendingApproval?.id
        ? {
            ...approval,
            status: approvalStatus,
            decidedAt: now,
            decisionNote: note,
          }
        : approval
    );
    const decidedGoal: GoalState = {
      ...goal,
      status: goalStatus,
      approvals,
      updatedAt: now,
    };
    await local.adapter.update(decidedGoal);
    await local.adapter.appendEvent(
      goal.id,
      createGoalEvent({
        goalId: goal.id,
        kind: "approval.decided",
        summary: pendingApproval
          ? `Approval ${approvalStatus}: ${pendingApproval.title}`
          : `Goal ${approvalStatus}`,
        payload: {
          approvalId: pendingApproval?.id ?? null,
          kind: pendingApproval?.kind ?? null,
          status: approvalStatus,
          decisionNote: note,
        },
      })
    );
    console.log(`Goal ${params.goalId} ${approvalStatus}`);
    return;
  }
  await updateGoalStatus({
    options: params.options,
    goalId: params.goalId,
    status: statusByCommand[params.action],
  });
}

export async function runGoalCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0];
  if (hasFlag(options, "help") || subcommand === "help") {
    printGoalHelp();
    return;
  }

  if (!subcommand || !["run", "answer", "approve", "reject", "pause", "resume", "cancel"].includes(subcommand)) {
    await createLocalGoal({
      options,
      objective: objectiveFromRest(rest, 'usage: goal "<objective>"'),
      kind: "general_code_goal",
    });
    return;
  }

  if (subcommand === "run") {
    await runGoal({
      options,
      goalId: requireOption(options, "goalId", "usage: goal run --goal-id <id>"),
    });
    return;
  }

  if (subcommand === "answer") {
    const questionId = rest[1];
    if (!questionId) {
      throw new Error("usage: goal answer <question-id> --choice <id>|--answer <text>");
    }
    await answerGoal({ options, questionId });
    return;
  }

  const goalId = rest[1] || optionString(options, "goalId");
  if (!goalId) {
    throw new Error(`usage: goal ${subcommand} <goal-id>`);
  }
  await applyGoalLifecycle({
    options,
    goalId,
    action: subcommand as "approve" | "reject" | "pause" | "resume" | "cancel",
  });
}
