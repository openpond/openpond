import { describe, expect, test } from "vitest";

import {
  assertCreateImproveTransition,
  nextCreateImproveRunRevision,
} from "@openpond/contracts";
import {
  createBlockedCreateImprovePlannerRun,
  runModelBackedCreateImprovePlanner,
} from "../apps/server/src/runtime/create-pipeline-planner";
import {
  attachModelTargetRefs,
  createImproveTargetAdapter,
} from "../apps/server/src/runtime/create-pipeline/target-adapters";
import { applyCreateImproveRunAction } from "../apps/server/src/runtime/create-pipeline/snapshots";
import { createTasksetRef } from "../apps/server/src/training/create-improve-taskset-lineage";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import { proposalFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("canonical Create/Improve planner", () => {
  test("maps a model decision onto the same run and links plan artifacts by runId", async () => {
    const run = createImproveRunFixture({
      id: "create_improve_support",
      target: {
        kind: "agent",
        id: "support-items",
        displayName: null,
        defaultActionKey: "support-items.chat",
      },
      objective: "Help me keep track of open customer support items.",
    });
    const planned = await planner(run, {
      schemaVersion: "openpond.createImprove.plannerDecision.v1",
      decision: "plan",
      plan: {
        targetId: "support-items",
        targetName: "Support Items",
        summary: "Create a support items Agent.",
        capturedContextSummary: "Direct request.",
        actionShape: {
          mode: "chat",
          label: "Chat only",
          detail: "Expose support tracking through chat.",
          defaultActionKey: "support-items.chat",
          directActionHint: null,
          artifactPolicy: "Persist the trace and run summary.",
        },
        sourcePlan: [{
          path: "agents/support-items",
          operation: "create",
          reason: "Implement the Agent.",
        }],
        requirements: [],
        checks: [{ name: "eval", command: "pnpm agent:eval", required: true }],
      },
    });

    expect(planned.id).toBe(run.id);
    expect(planned.revision).toBe(run.revision + 1);
    expect(planned.state).toBe("awaiting_plan_approval");
    expect(planned.plan).toMatchObject({
      runId: run.id,
      status: "pending_approval",
      metadata: {
        actionShapeDecisionSource: "model_planner",
      },
    });
    expect(planned.workflowCapture?.runId).toBe(run.id);
    expect(planned.target).toMatchObject({
      kind: "agent",
      id: "support-items",
      displayName: "Support Items",
    });
  });

  test("keeps the target id and default chat action key aligned when planning renames an Agent", async () => {
    const run = createImproveRunFixture({
      target: {
        kind: "agent",
        id: "monitor-customer-account-health",
        displayName: "Monitor customer account health",
        defaultActionKey: "monitor-customer-account-health.chat",
      },
      objective: "Monitor customer account health and produce a weekly review.",
    });
    const planned = await planner(run, {
      schemaVersion: "openpond.createImprove.plannerDecision.v1",
      decision: "plan",
      plan: {
        targetId: "account-health-agent",
        targetName: "Account Health Agent",
        summary: "Create the Account Health Agent.",
        capturedContextSummary: "Direct request.",
        actionShape: {
          ...actionShape(),
          defaultActionKey: "account-health-agent.chat",
        },
        defaultChatAction: {
          key: "account-health-agent.chat",
          label: "Chat",
          required: true,
        },
        sourcePlan: [],
        requirements: [],
        checks: [],
      },
    });

    expect(planned.target).toMatchObject({
      kind: "agent",
      id: "account-health-agent",
      defaultActionKey: "account-health-agent.chat",
    });
    expect(planned.plan?.defaultChatAction.key).toBe("account-health-agent.chat");
  });

  test("normalizes question and source-operation aliases before validation", async () => {
    const questionRun = await planner(createImproveRunFixture(), {
      schemaVersion: "openpond.createImprove.plannerDecision.v1",
      decision: "questions",
      summary: "Need one choice.",
      questions: [{
        kind: "dropdown",
        title: "Output",
        prompt: "Which output should the Agent create?",
        required: true,
        options: [{ label: "Summary", value: "summary" }],
      }],
    });
    expect(questionRun.questions[0]?.kind).toBe("single_choice");

    const planned = await planner(createImproveRunFixture(), {
      schemaVersion: "openpond.createImprove.plannerDecision.v1",
      decision: "plan",
      plan: {
        targetId: "support",
        targetName: "Support",
        summary: "Update support.",
        capturedContextSummary: "Fixture.",
        actionShape: actionShape(),
        sourcePlan: [{
          path: "agents/support",
          operation: "modify",
          reason: "Revise the source.",
        }],
        requirements: [],
        checks: [],
      },
    });
    expect(planned.plan?.sourcePlan[0]?.operation).toBe("update");
  });

  test("normalizes a nearly-valid question envelope from a hosted model", async () => {
    const run = createImproveRunFixture();
    let calls = 0;
    const planned = await runModelBackedCreateImprovePlanner({
      run,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "planner_question_aliases",
      signal: new AbortController().signal,
      stream: async function* () {
        calls += 1;
        yield {
          text: JSON.stringify({
            schemaVersion: "v1",
            questions: [
              { question: "Which files should the Agent prioritize?" },
              {
                text: "Choose the preferred search strategy.",
                options: ["Repository files", { name: "Attached documents", value: "attachments" }],
              },
            ],
          }),
        };
      },
    });

    expect(calls).toBe(1);
    expect(planned.state).toBe("awaiting_questions");
    expect(planned.questions).toMatchObject([
      {
        title: "Which files should the Agent prioritize",
        prompt: "Which files should the Agent prioritize?",
        kind: "free_text",
      },
      {
        title: "Choose the preferred search strategy",
        prompt: "Choose the preferred search strategy.",
        kind: "single_choice",
        options: [
          { label: "Repository files", value: "Repository files" },
          { label: "Attached documents", value: "attachments" },
        ],
      },
    ]);
  });

  test("turns Lab improvement implementation questions into an actionable plan", async () => {
    const run = createImproveRunFixture({
      operation: "improve",
      surface: "lab_improve",
      command: "lab_improve",
      objective: "I think my agent can be better at finding the right files before answering.",
      target: {
        kind: "agent",
        id: "default",
        displayName: "default",
        defaultActionKey: "default.chat",
      },
    });
    let calls = 0;
    const planned = await runModelBackedCreateImprovePlanner({
      run,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "lab_improve_default_plan",
      signal: new AbortController().signal,
      stream: async function* () {
        calls += 1;
        throw new Error("Lab improvement planning should not call the model.");
      },
    });

    expect(calls).toBe(0);
    expect(planned.state).toBe("awaiting_plan_approval");
    expect(planned.questions).toEqual([]);
    expect(planned.plan).toMatchObject({
      summary: "Improve default: I think my agent can be better at finding the right files before answering.",
      defaultChatAction: {
        key: "default.chat",
        label: "default",
      },
      sourcePlan: [
        {
          path: "agent",
          operation: "update",
        },
        {
          path: "settings/profile.yaml",
          operation: "update",
        },
      ],
      metadata: {
        actionShapeDecisionSource: "lab_improve_default_planner",
        planner: {
          kind: "deterministic",
          source: "lab_improve_default_planner",
        },
      },
    });
  });

  test("preserves Account Health direct actions in deterministic Lab improvement plans", async () => {
    const run = createImproveRunFixture({
      operation: "improve",
      surface: "lab_improve",
      command: "lab_improve",
      objective: "Correct renewal risk so billing and P1 blockers rank first.",
      target: {
        kind: "agent",
        id: "account-health-agent",
        displayName: "Account Health Agent",
        defaultActionKey: "account-health-agent.chat",
      },
    });
    const planned = await runModelBackedCreateImprovePlanner({
      run,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "lab_improve_account_health",
      signal: new AbortController().signal,
      stream: async function* () {
        throw new Error("Lab improvement planning should not call the model.");
      },
    });

    expect(planned.plan?.metadata.actionShape).toMatchObject({
      mode: "chat_and_direct_actions",
      defaultActionKey: "account-health-agent.chat",
    });
    expect(String(planned.plan?.metadata.actionShape && (planned.plan.metadata.actionShape as any).directActionHint)).toContain("summarize-account");
  });

  test("repairs invalid requirement bullets without creating a second run", async () => {
    const run = createImproveRunFixture();
    let calls = 0;
    const planned = await runModelBackedCreateImprovePlanner({
      run,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "planner_repair",
      signal: new AbortController().signal,
      stream: async function* () {
        calls += 1;
        yield {
          text: JSON.stringify(calls === 1
            ? {
                schemaVersion: "openpond.createImprove.plannerDecision.v1",
                decision: "plan",
                plan: {
                  targetId: "support",
                  targetName: "Support",
                  summary: "Create support.",
                  capturedContextSummary: "Fixture.",
                  actionShape: actionShape(),
                  sourcePlan: [],
                  requirements: ["Must answer customers"],
                  checks: [],
                },
              }
            : {
                schemaVersion: "openpond.createImprove.plannerDecision.v1",
                decision: "plan",
                plan: {
                  targetId: "support",
                  targetName: "Support",
                  summary: "Create support.",
                  capturedContextSummary: "Fixture.",
                  actionShape: actionShape(),
                  sourcePlan: [],
                  requirements: [],
                  checks: [],
                },
              }),
        };
      },
    });

    expect(calls).toBe(2);
    expect(planned.id).toBe(run.id);
    expect(planned.plan?.requirements).toEqual([]);
  });

  test("records planner failure as a blocked revision of the same run", () => {
    const run = createImproveRunFixture();
    const blocked = createBlockedCreateImprovePlannerRun({
      run,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      reason: "Planner returned invalid JSON.",
    });
    expect(blocked).toMatchObject({
      id: run.id,
      revision: 1,
      state: "blocked",
      blockedReason: "Planner returned invalid JSON.",
    });
  });

  test("uses one target adapter contract for Agent and Model workproducts", () => {
    const agentRun = createImproveRunFixture();
    const agentAdapter = createImproveTargetAdapter(agentRun.target);
    expect(agentAdapter.kind).toBe("agent");
    expect(agentAdapter.planningContext(agentRun)).toMatchObject({
      operation: "create",
      target: agentRun.target,
    });
    expect(agentAdapter.allowedPaths(agentRun)).toEqual([]);

    const modelRun = createImproveRunFixture({
      target: {
        kind: "model",
        id: "model-draft",
        displayName: "Support model",
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
      state: "evaluating",
      plan: {
        ...createImproveRunFixture({ state: "awaiting_plan_approval" }).plan!,
        runId: "create_improve_fixture",
        status: "approved",
      },
    });
    const updated = attachModelTargetRefs({
      run: modelRun,
      tasksetId: "taskset_support",
      trainingPlanId: "plan_support",
      trainingJobId: "job_support",
      artifactId: "artifact_support",
      evaluations: [{
        subject: "candidate",
        attemptRefs: ["attempt_support"],
        gradeRefs: ["grade_support"],
        total: 1,
        passed: 1,
        failed: 0,
        executionContractHash: "contract_support",
      }],
      completed: true,
    });
    expect(updated.target).toMatchObject({
      kind: "model",
      trainingPlanId: "plan_support",
      trainingJobId: "job_support",
      artifactId: "artifact_support",
    });
    expect(updated.state).toBe("ready");
    expect(updated.externalExecutionRefs).toContainEqual(expect.objectContaining({
      kind: "training_job",
      id: "job_support",
    }));
  });

  test("rejects invalid transitions and advances valid revisions exactly once", () => {
    expect(() => assertCreateImproveTransition("planning", "ready")).toThrow(
      "Invalid Create/Improve transition",
    );
    const run = createImproveRunFixture();
    const next = nextCreateImproveRunRevision(run, {
      state: "awaiting_plan_approval",
      updatedAt: "2026-07-01T10:00:01.000Z",
    }, "action_1");
    expect(next.revision).toBe(1);
    expect(next.appliedActionIds).toEqual(["action_1"]);
  });

  test("opens or rejects an evaluated Agent candidate through revisioned PR actions", () => {
    const candidateId = "agent_candidate_fixture";
    const run = createImproveRunFixture({
      operation: "improve",
      state: "awaiting_promotion",
      candidates: [{
        id: candidateId,
        target: {
          kind: "agent",
          id: "fixture-agent",
          displayName: "Fixture Agent",
          defaultActionKey: "fixture-agent.chat",
        },
        status: "evaluated",
        git: {
          baseBranch: "main",
          baseCommit: "a".repeat(40),
          branch: "openpond/improve/fixture",
          headCommit: "b".repeat(40),
          remoteName: "origin",
          remoteUrl: "git@github.com:openpond/profile.git",
          worktreePath: "/tmp/candidate",
          changedPaths: ["profiles/default/agents/fixture-agent/agent/agent.ts"],
          diffStat: "1 file changed",
          pullRequest: null,
        },
        sourceRefs: [],
        artifactRefs: [],
        checkRefs: [],
        evaluationReceiptRefs: ["candidate_eval"],
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:00:00.000Z",
        metadata: {},
      }],
      evaluationReceipts: [{
        id: "candidate_eval",
        candidateId,
        target: {
          kind: "agent",
          id: "fixture-agent",
          displayName: "Fixture Agent",
          defaultActionKey: "fixture-agent.chat",
        },
        evaluatorKind: "agent_sdk",
        subject: "candidate",
        sourceCommit: "b".repeat(40),
        sourceBranch: "openpond/improve/fixture",
        status: "passed",
        publishGate: "passed",
        summaryCounts: { total: 1, passed: 1, failed: 0 },
        evalRefs: ["fixture"],
        artifactRefs: [],
        summary: "1/1 passed",
        createdAt: "2026-07-01T10:00:00.000Z",
        metadata: {},
      }],
    });

    const opening = applyCreateImproveRunAction(run, {
      type: "open_pull_request",
      runId: run.id,
      expectedRevision: run.revision,
      actionId: "open_pr",
      candidateId,
    });
    expect(opening).toMatchObject({
      state: "opening_pull_request",
      releaseOutcome: { status: "pending" },
    });

    const taskset = tasksetFixture();
    const tasksetRef = createTasksetRef({
      taskset,
      proposal: proposalFixture(),
      evidenceSnapshotIds: ["evidence_snapshot_fixture"],
      approvedAt: "2026-07-01T10:00:00.000Z",
    });
    const forged = createImproveRunFixture({
      ...run,
      tasksetRef,
      candidates: run.candidates.map((candidate) => ({ ...candidate, tasksetRef })),
      evaluationReceipts: run.evaluationReceipts.map((receipt) => ({
        ...receipt,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        taskAttemptRefs: ["candidate_controlled_attempt"],
        metadata: { executionContractHash: "candidate-controlled" },
      })),
    });
    expect(() => applyCreateImproveRunAction(forged, {
      type: "apply_candidate",
      runId: forged.id,
      expectedRevision: forged.revision,
      actionId: "apply_forged",
      candidateId,
    })).toThrow("trusted receipt");

    const rejected = applyCreateImproveRunAction(run, {
      type: "reject_candidate",
      runId: run.id,
      expectedRevision: run.revision,
      actionId: "reject_candidate",
      candidateId,
      reason: "Not the intended behavior.",
    });
    expect(rejected).toMatchObject({
      state: "rejected",
      releaseOutcome: { status: "rejected" },
      blockedReason: "Not the intended behavior.",
    });
    expect(rejected.candidates[0]?.status).toBe("rejected");
  });
});

async function planner(run: ReturnType<typeof createImproveRunFixture>, decision: unknown) {
  return runModelBackedCreateImprovePlanner({
    run,
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    requestId: `planner_${run.id}`,
    signal: new AbortController().signal,
    stream: async function* () {
      yield { text: JSON.stringify(decision) };
    },
  });
}

function actionShape() {
  return {
    mode: "chat",
    label: "Chat only",
    detail: "Expose through chat.",
    defaultActionKey: "chat",
    directActionHint: null,
    artifactPolicy: "Persist trace and run summary.",
  };
}
