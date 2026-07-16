import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createLocalGoal, runGoalCommand } from "../src/goal/cli";
import { LocalGoalStateAdapter } from "../src/goal/state/local";
import type { GoalAnswer, GoalQuestion, GoalState } from "../src/goal/types";

async function readCreatePlan(workspace: string, goalId: string): Promise<{
  id?: string;
  approvalId?: string;
  status?: string;
  summary?: string;
  editedFromPlanId?: string | null;
  defaultChatAction?: { key?: string | null };
  sourcePlan?: Array<{ path?: string; operation?: string; reason?: string }>;
  checks?: Array<{ name?: string; command?: string; required?: boolean }>;
  metadata?: {
    actionShape?: {
      mode?: string;
      label?: string;
      detail?: string;
      directActionHint?: string | null;
    };
  } & Record<string, unknown>;
}> {
  const goalDir = join(workspace, ".openpond", "goals", goalId);
  return JSON.parse(await readFile(join(goalDir, "create-plan.json"), "utf8")) as {
    id?: string;
    approvalId?: string;
    status?: string;
    summary?: string;
    editedFromPlanId?: string | null;
    defaultChatAction?: { key?: string | null };
    sourcePlan?: Array<{ path?: string; operation?: string; reason?: string }>;
    checks?: Array<{ name?: string; command?: string; required?: boolean }>;
    metadata?: {
      actionShape?: {
        mode?: string;
        label?: string;
        detail?: string;
        directActionHint?: string | null;
      };
    } & Record<string, unknown>;
  };
}

async function readWorkflowCapture(workspace: string, goalId: string): Promise<{
  schemaVersion?: string;
}> {
  const goalDir = join(workspace, ".openpond", "goals", goalId);
  return JSON.parse(
    await readFile(join(goalDir, "workflow-capture.json"), "utf8")
  ) as {
    schemaVersion?: string;
  };
}

async function readCreatePipeline(workspace: string, goalId: string): Promise<{
  state?: string;
  questionIds?: string[];
}> {
  const goalDir = join(workspace, ".openpond", "goals", goalId);
  return JSON.parse(await readFile(join(goalDir, "create-pipeline.json"), "utf8")) as {
    state?: string;
    questionIds?: string[];
  };
}

async function captureConsoleLog(run: () => Promise<void>): Promise<string[]> {
  const originalConsoleLog = console.log;
  const logs: string[] = [];
  try {
    console.log = (...values: unknown[]) => {
      logs.push(values.map((value) => String(value ?? "")).join(" "));
    };
    await run();
    return logs;
  } finally {
    console.log = originalConsoleLog;
  }
}

async function getGoal(workspace: string, goalId: string): Promise<GoalState> {
  const goal = await new LocalGoalStateAdapter(workspace).get(goalId);
  if (!goal) throw new Error(`goal not found: ${goalId}`);
  return goal;
}

describe("create pipeline", () => {
  test("persists local create plan, workflow capture, and approval gate", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-create-pipeline-"));
    const goal = await createLocalGoal({
      options: { cwd: workspace, goalStorage: "workspace" },
      objective: "Create an agent that summarizes support tickets",
      kind: "create_agent",
    });

    expect(goal.status).toBe("awaiting_approval");
    expect(goal.createPipeline?.state).toBe("awaiting_plan_approval");
    expect(goal.createPipeline?.plan?.status).toBe("pending_approval");
    expect(goal.approvals[0]?.kind).toBe("create_plan");

    const plan = await readCreatePlan(workspace, goal.id);
    const capture = await readWorkflowCapture(workspace, goal.id);

    expect(plan.approvalId).toBe(goal.approvals[0]?.id);
    expect(plan.defaultChatAction?.key).toBe("chat");
    expect(plan.metadata?.actionShape).toMatchObject({
      mode: "chat",
      label: "Chat only",
    });
    expect(plan.sourcePlan?.map((item) => item.path)).toEqual([
      "agents/create-an-agent-that-summarizes-support-tickets",
      "settings/profile.yaml",
      "agents/create-an-agent-that-summarizes-support-tickets/.openpond/agent-manifest.json",
      "agents/create-an-agent-that-summarizes-support-tickets/.openpond/action-registry.json",
    ]);
    expect(JSON.stringify(plan.sourcePlan)).not.toContain("agent/**");
    expect(JSON.stringify(plan.sourcePlan)).not.toContain("agent/agent.ts");
    expect(plan.checks?.map((check) => check.name)).toEqual([
      "inspect",
      "build",
      "validate",
      "eval",
    ]);
    expect(JSON.stringify(plan.checks)).not.toContain("smoke");
    expect(capture.schemaVersion).toBe("openpond.createPipeline.workflowCapture.v1");

    const planLogs = await captureConsoleLog(async () => {
      await runGoalCommand({ cwd: workspace, goalStorage: "workspace" }, ["plan", goal.id]);
    });
    const planOutput = planLogs.join("\n");
    expect(planOutput).toContain(`Goal: ${goal.id}`);
    expect(planOutput).toContain("Pipeline: awaiting_plan_approval");
    expect(planOutput).toContain("Action shape:");
    expect(planOutput).toContain("Chat only");
    expect(planOutput).not.toContain("Direct action:");
    expect(planOutput).toContain("agents/create-an-agent-that-summarizes-support-tickets");
    expect(planOutput).not.toContain("agent/**");
    expect(planOutput).not.toContain("agent/agent.ts");
    expect(planOutput).toContain("Approve: openpond goal approve");
    expect(planOutput).toContain("Reject: openpond goal reject");

    await runGoalCommand({ cwd: workspace, goalId: goal.id, goalStorage: "workspace" }, ["approve"]);
    const approved = await getGoal(workspace, goal.id);
    const approvedPlan = await readCreatePlan(workspace, goal.id);

    expect(approved.status).toBe("queued");
    expect(approved.approvals[0]?.status).toBe("approved");
    expect(approved.createPipeline?.state).toBe("applying_source");
    expect(approved.createPipeline?.plan?.status).toBe("approved");
    expect(approvedPlan.status).toBe("approved");
  });

  test("links durable Goal questions into the create pipeline snapshot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-create-pipeline-question-"));
    const goal = await createLocalGoal({
      options: { cwd: workspace, goalStorage: "workspace" },
      objective: "Create an agent that posts release notes",
      kind: "create_agent",
    });
    const localState = new LocalGoalStateAdapter(workspace);
    const question: GoalQuestion = {
      id: "question_channel",
      goalId: goal.id,
      title: "Which channel?",
      reason: "The release notes agent needs a default publishing channel.",
      required: true,
      options: [{ id: "chat", label: "Chat" }],
      freeformAllowed: true,
      answeredAt: null,
    };

    const awaiting = await localState.addQuestion(goal.id, question);
    expect(awaiting.status).toBe("awaiting_user_input");
    expect(awaiting.createPipeline?.state).toBe("awaiting_questions");
    expect(awaiting.createPipeline?.questionIds).toContain(question.id);
    expect((await readCreatePipeline(workspace, goal.id)).questionIds).toContain(question.id);

    const answer: GoalAnswer = {
      id: "answer_channel",
      goalId: goal.id,
      questionId: question.id,
      optionId: "chat",
      freeformText: null,
      value: { optionId: "chat" },
      createdAt: new Date().toISOString(),
    };
    const resumed = await localState.answerQuestion({
      goalId: goal.id,
      questionId: question.id,
      answer,
    });

    expect(resumed.status).toBe("queued");
    expect(resumed.createPipeline?.state).toBe("awaiting_plan_approval");
    expect(resumed.createPipeline?.questionIds).toContain(question.id);
    expect((await readCreatePipeline(workspace, goal.id)).state).toBe("awaiting_plan_approval");
  });

  test("rejects a pending create plan without mutating source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-create-pipeline-reject-"));
    const goal = await createLocalGoal({
      options: { cwd: workspace, goalStorage: "workspace" },
      objective: "Create an agent that drafts weekly updates",
      kind: "create_agent",
    });

    await runGoalCommand(
      { cwd: workspace, goalId: goal.id, note: "Narrow the scope first.", goalStorage: "workspace" },
      ["reject"]
    );
    const rejected = await getGoal(workspace, goal.id);
    const rejectedPlan = await readCreatePlan(workspace, goal.id);

    expect(rejected.status).toBe("blocked");
    expect(rejected.approvals[0]?.status).toBe("rejected");
    expect(rejected.approvals[0]?.decisionNote).toBe("Narrow the scope first.");
    expect(rejected.createPipeline?.state).toBe("blocked");
    expect(rejected.createPipeline?.blockedReason).toBe(
      "Create plan rejected before source mutation."
    );
    expect(rejected.createPipeline?.plan?.status).toBe("rejected");
    expect(rejectedPlan.status).toBe("rejected");
    expect(rejectedPlan.metadata?.decisionNote).toBe("Narrow the scope first.");
  });

  test("edits a pending create plan before source mutation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-create-pipeline-edit-plan-"));
    const goal = await createLocalGoal({
      options: { cwd: workspace, goalStorage: "workspace" },
      objective: "Create an agent that drafts customer replies",
      kind: "create_agent",
    });
    const originalPlan = await readCreatePlan(workspace, goal.id);

    const editLogs = await captureConsoleLog(async () => {
      await runGoalCommand(
        { cwd: workspace, edit: "Focus on refund requests and keep replies concise.", goalStorage: "workspace" },
        ["plan", goal.id]
      );
    });
    const edited = await getGoal(workspace, goal.id);
    const editedPlan = await readCreatePlan(workspace, goal.id);

    expect(editLogs.join("\n")).toContain("plan revised");
    expect(edited.status).toBe("awaiting_approval");
    expect(edited.createPipeline?.state).toBe("awaiting_plan_approval");
    expect(edited.createPipeline?.plan?.status).toBe("pending_approval");
    expect(editedPlan.id).not.toBe(originalPlan.id);
    expect(editedPlan.editedFromPlanId).toBe(originalPlan.id);
    expect(editedPlan.summary).toContain("Focus on refund requests");
    expect(edited.approvals[0]?.status).toBe("pending");
    expect(edited.approvals[0]?.payload).toMatchObject({
      planId: editedPlan.id,
      previousPlanId: originalPlan.id,
      revision: "Focus on refund requests and keep replies concise.",
    });
    expect(edited.events.at(-1)?.kind).toBe("create_plan.created");

    await runGoalCommand({ cwd: workspace, goalId: goal.id, goalStorage: "workspace" }, ["approve"]);
    const approved = await getGoal(workspace, goal.id);
    expect(approved.status).toBe("queued");
    expect(approved.createPipeline?.state).toBe("applying_source");
    expect(approved.createPipeline?.plan?.id).toBe(editedPlan.id);
  });

  test("cancels a pending create plan and records the cancelled artifact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-create-pipeline-cancel-"));
    const goal = await createLocalGoal({
      options: { cwd: workspace, goalStorage: "workspace" },
      objective: "Create an agent that watches invoice uploads",
      kind: "create_agent",
    });

    await runGoalCommand(
      { cwd: workspace, goalId: goal.id, note: "User withdrew the request.", goalStorage: "workspace" },
      ["cancel"]
    );
    const cancelled = await getGoal(workspace, goal.id);
    const cancelledPlan = await readCreatePlan(workspace, goal.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.approvals[0]?.status).toBe("cancelled");
    expect(cancelled.approvals[0]?.decisionNote).toBe("User withdrew the request.");
    expect(cancelled.createPipeline?.state).toBe("cancelled");
    expect(cancelled.createPipeline?.blockedReason).toBe(
      "Create plan cancelled before source mutation."
    );
    expect(cancelled.createPipeline?.plan?.status).toBe("cancelled");
    expect(cancelledPlan.status).toBe("cancelled");
    expect(cancelledPlan.metadata?.decisionNote).toBe("User withdrew the request.");
  });

  test("keeps ordinary goal cancellation on the status lifecycle path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-general-goal-cancel-"));
    const goal = await createLocalGoal({
      options: { cwd: workspace, goalStorage: "workspace" },
      objective: "Refactor the docs",
      kind: "general_code_goal",
    });

    await runGoalCommand({ cwd: workspace, goalId: goal.id, goalStorage: "workspace" }, ["cancel"]);
    const cancelled = await getGoal(workspace, goal.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.approvals).toHaveLength(0);
    expect(cancelled.events.at(-1)?.kind).toBe("goal.status_changed");
  });

  test("blocks CLI-approved local create plans without a model-backed apply runtime", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-create-pipeline-local-run-"));
    const repoPath = join(workspace, "profile-repo");
    const sourcePath = join(repoPath, "profiles", "default");
    await mkdir(join(sourcePath, "agent"), { recursive: true });
    await mkdir(join(sourcePath, "agents", "existing-agent", "agent"), { recursive: true });
    await writeFile(
      join(sourcePath, "agent", "agent.ts"),
      "export const existingDefaultSource = 'do-not-clobber-default';\n",
      "utf8",
    );
    await writeFile(
      join(sourcePath, "agents", "existing-agent", "agent", "agent.ts"),
      "export const existingGeneratedSource = 'do-not-clobber-existing-agent';\n",
      "utf8",
    );
    const objective = "Create an agent that summarizes support tickets";
    const goal = await createLocalGoal({
      options: { cwd: sourcePath, goalStorage: "workspace" },
      objective,
      kind: "create_agent",
      createPipeline: {
        command: "openpond extend",
        surface: "local_extend",
        profile: {
          activeProfile: "default",
          repoPath,
          sourcePath,
          localHead: null,
        },
      },
    });

    await captureConsoleLog(async () => {
      await runGoalCommand({ cwd: sourcePath, goalId: goal.id, goalStorage: "workspace" }, ["approve"]);
      await runGoalCommand({ cwd: sourcePath, goalId: goal.id, goalStorage: "workspace" }, ["run"]);
    });
    const blocked = await getGoal(sourcePath, goal.id);
    const generatedSourcePath = join(
      sourcePath,
      "agents",
      "create-an-agent-that-summarizes-support-tickets",
    );
    const defaultSource = await readFile(join(sourcePath, "agent", "agent.ts"), "utf8");
    const existingGeneratedSource = await readFile(
      join(sourcePath, "agents", "existing-agent", "agent", "agent.ts"),
      "utf8",
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.createPipeline?.state).toBe("blocked");
    expect(blocked.createPipeline?.plan?.status).toBe("approved");
    expect(blocked.createPipeline?.blockedReason).toContain("model-backed SDK source application");
    expect(existsSync(generatedSourcePath)).toBe(false);
    expect(existsSync(join(repoPath, "openpond-profile.json"))).toBe(false);
    expect(defaultSource).toContain("do-not-clobber-default");
    expect(existingGeneratedSource).toContain("do-not-clobber-existing-agent");
    expect(blocked.events.some((event) => event.kind === "source.updated")).toBe(false);
    expect(blocked.events.some((event) => event.kind === "check.completed")).toBe(false);
  });

  test("blocks CLI-approved local edit plans without a model-backed apply runtime", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-edit-pipeline-local-run-"));
    const repoPath = join(workspace, "profile-repo");
    const sourcePath = join(repoPath, "profiles", "default");
    await mkdir(join(sourcePath, "agents", "support-agent", "agent"), { recursive: true });
    await writeFile(
      join(sourcePath, "agents", "support-agent", "agent", "agent.ts"),
      "export const supportAgentSource = 'do-not-clobber-support-agent';\n",
      "utf8",
    );
    const objective = "Edit the support agent to triage refund requests";
    const goal = await createLocalGoal({
      options: { cwd: sourcePath, agentId: "support-agent", goalStorage: "workspace" },
      objective,
      kind: "update_agent",
      createPipeline: {
        command: "/edit",
        surface: "direct_prompt_edit",
        profile: {
          activeProfile: "default",
          repoPath,
          sourcePath,
          localHead: null,
        },
      },
    });

    await captureConsoleLog(async () => {
      await runGoalCommand({ cwd: sourcePath, goalId: goal.id, goalStorage: "workspace" }, ["approve"]);
      await runGoalCommand({ cwd: sourcePath, goalId: goal.id, goalStorage: "workspace" }, ["run"]);
    });
    const blocked = await getGoal(sourcePath, goal.id);
    const agentSource = await readFile(
      join(sourcePath, "agents", "support-agent", "agent", "agent.ts"),
      "utf8",
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.createPipeline?.request.operation).toBe("edit");
    expect(blocked.createPipeline?.state).toBe("blocked");
    expect(blocked.createPipeline?.plan?.status).toBe("approved");
    expect(blocked.createPipeline?.blockedReason).toContain("model-backed SDK source application");
    expect(agentSource).toContain("do-not-clobber-support-agent");
    expect(agentSource).not.toContain(objective);
    expect(existsSync(join(repoPath, "openpond-profile.json"))).toBe(false);
    expect(blocked.events.some((event) => event.kind === "source.updated")).toBe(false);
    expect(blocked.events.some((event) => event.kind === "check.completed")).toBe(false);
  });
});
