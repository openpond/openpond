import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CreatePipelineRequestSchema } from "@openpond/contracts";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import {
  createPipelineSnapshotFromPlannerDecision,
  runModelBackedCreatePipelinePlanner,
} from "../apps/server/src/runtime/create-pipeline-planner";

const now = "2026-07-01T00:00:00.000Z";

describe("model-backed create pipeline planner", () => {
  test("maps a model planner decision to a pre-approval create plan with provenance", async () => {
    const request = createPipelineRequest();

    const snapshot = await runModelBackedCreatePipelinePlanner({
      request,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "planner_test",
      signal: new AbortController().signal,
      stream: async function* () {
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.createPipeline.plannerDecision.v1",
            decision: "plan",
            plan: {
              agentId: "support-items",
              agentName: "Support Items",
              summary: "Create a support items assistant from approved local fixtures.",
              capturedContextSummary: "Direct request for tracking open support items.",
              actionShape: {
                mode: "chat_and_direct_actions",
                label: "Chat plus direct action",
                detail: "Use chat for follow-up questions and a direct action for the open-items summary.",
                defaultActionKey: "chat",
                directActionHint: "Summarize open support items.",
                artifactPolicy: "Persist trace, run summary, and a markdown summary when produced.",
              },
              sourcePlan: [
                {
                  path: "agents/support-items",
                  operation: "create",
                  reason: "Implement the approved support items agent.",
                },
              ],
              requirements: [],
              checks: [
                { name: "inspect", command: "bun run agent:inspect", required: true },
                { name: "build", command: "bun run build", required: true },
                { name: "validate", command: "bun run agent:validate", required: true },
                { name: "eval", command: "bun run agent:eval", required: true },
              ],
            },
          }),
        };
      },
    });

    expect(snapshot.state).toBe("awaiting_plan_approval");
    expect(snapshot.plan?.metadata.actionShapeDecisionSource).toBe("model_planner");
    expect(snapshot.plan?.metadata.planner).toMatchObject({
      kind: "model",
      source: "create_pipeline_model_planner",
      providerId: "openpond",
      modelId: "openpond-chat",
    });
    expect(snapshot.plan?.metadata.actionShape).toMatchObject({
      mode: "chat_and_direct_actions",
      directActionHint: "Summarize open support items.",
    });
    expect(snapshot.plan?.sourcePlan[0]?.path).toBe("agents/support-items");
    expect(snapshot.approvalIds).toEqual([snapshot.plan?.approvalId]);
  });

  test("normalizes model planner question-kind aliases before schema validation", async () => {
    const request = createPipelineRequest();

    const snapshot = await runModelBackedCreatePipelinePlanner({
      request,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "planner_question_alias_test",
      signal: new AbortController().signal,
      stream: async function* () {
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.createPipeline.plannerDecision.v1",
            decision: "questions",
            questions: [
              {
                title: "Data source",
                prompt: "Where should this agent read from?",
                kind: "multiple_choice",
                options: [
                  { label: "Committed local fixtures", value: "fixtures" },
                  { label: "Existing local file", value: "local_file" },
                ],
              },
              {
                title: "Output detail",
                prompt: "Any required wording for the summary?",
                kind: "text",
                options: [],
              },
            ],
          }),
        };
      },
    });

    expect(snapshot.state).toBe("awaiting_questions");
    expect(snapshot.questions[0]?.kind).toBe("single_choice");
    expect(snapshot.questions[1]?.kind).toBe("free_text");
  });

  test("normalizes model planner source-plan operation aliases before schema validation", async () => {
    const request = createPipelineRequest();

    const snapshot = await runModelBackedCreatePipelinePlanner({
      request,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      requestId: "planner_source_operation_alias_test",
      signal: new AbortController().signal,
      stream: async function* () {
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.createPipeline.plannerDecision.v1",
            decision: "plan",
            plan: {
              agentId: "vendor-renewal-helper",
              agentName: "Vendor Renewal Helper",
              summary: "Create a vendor renewal helper from the captured conversation.",
              capturedContextSummary:
                "The chat requested committed fixtures for vendor name, renewal date, owner, spend, risk, and next action.",
              actionShape: {
                mode: "chat_and_direct_actions",
                label: "Chat plus summary action",
                detail: "Use chat for follow-up questions and a direct action for a keepable renewal summary.",
                defaultActionKey: "chat",
                directActionHint: "Produce a vendor renewal attention summary.",
                artifactPolicy: "Persist trace, run summary, and a markdown summary when produced.",
              },
              sourcePlan: [
                {
                  path: "agents/vendor-renewal-helper",
                  operation: "write",
                  reason: "Author the generated SDK source.",
                },
                {
                  path: "settings/profile.yaml",
                  operation: "register",
                  reason: "Register the generated agent in the active profile.",
                },
                {
                  path: "openpond-profile.json",
                  operation: "verify",
                  reason: "Confirm the profile repo manifest is aligned.",
                },
              ],
              requirements: [],
              checks: [
                { name: "inspect", command: "bun run agent:inspect", required: true },
                { name: "build", command: "bun run build", required: true },
                { name: "validate", command: "bun run agent:validate", required: true },
                { name: "eval", command: "bun run agent:eval", required: true },
              ],
            },
          }),
        };
      },
    });

    expect(snapshot.state).toBe("awaiting_plan_approval");
    expect(snapshot.plan?.sourcePlan.map((item) => item.operation)).toEqual([
      "create",
      "update",
      "inspect",
    ]);
    expect(snapshot.plan?.metadata.actionShapeDecisionSource).toBe("model_planner");
  });

  test("server create turns invoke the planner before plan review", async () => {
    let session = baseSession();
    const turns: any[] = [];
    const events: any[] = [];
    const approvals: any[] = [];
    const request = createPipelineRequest();
    const plannerCalls: any[] = [];

    const runner = createTurnRunner({
      attachmentRootDir: await mkdtemp(join(tmpdir(), "openpond-create-planner-")),
      store: {
        async snapshot() {
          return { events, turns, approvals };
        },
        async getTurn(turnId: string) {
          return turns.find((candidate) => candidate.id === turnId) ?? null;
        },
        async insertTurn(turn: any) {
          turns.push(turn);
        },
        async updateTurn(turnId: string, updater: (turn: any) => any) {
          const index = turns.findIndex((candidate) => candidate.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]);
          return turns[index];
        },
        async getApproval(approvalId: string) {
          return approvals.find((candidate) => candidate.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval: any) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId: string, patch: Record<string, unknown>) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId: string, turnId: string, providerTurnId: string | null = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-07-01T00:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session: any, turnId: string, message: string) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session: any, turnId: string) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("apps should not load for create planning");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("source runtime should not start before plan approval");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => {
        throw new Error("workspace diff should not run during create planning");
      },
      appendRuntimeEvent: async (event: any) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tools should not run during create planning");
      },
      loadPersonalizationSoul: async () => {
        throw new Error("normal chat personalization should not load during create planning");
      },
      maybeCreateScaffoldForTurn: async () => {
        throw new Error("normal chat scaffold should not run during create planning");
      },
      hostedSystemPrompt: async () => {
        throw new Error("normal chat prompt should not build during create planning");
      },
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      planCreatePipeline: async (input) => {
        plannerCalls.push(input);
        return createPipelineSnapshotFromPlannerDecision({
          request: input.request,
          previousSnapshot: input.previousSnapshot,
          modelRef: input.modelRef,
          decision: {
            schemaVersion: "openpond.createPipeline.plannerDecision.v1",
            decision: "plan",
            plan: {
              agentId: "support-items",
              agentName: "Support Items",
              summary: "Create a model-planned support items agent.",
              capturedContextSummary: "Direct request.",
              actionShape: {
                mode: "chat",
                label: "Chat only",
                detail: "Expose through chat.",
                defaultActionKey: "chat",
                directActionHint: null,
                artifactPolicy: "Persist trace and run summary.",
              },
              sourcePlan: [
                {
                  path: "agents/support-items",
                  operation: "create",
                  reason: "Implement the approved model-planned agent.",
                },
              ],
              requirements: [],
              checks: [],
            },
          },
        });
      },
      turnFollowUpQueue: {
        enqueue() {
          return { id: "unused" };
        },
      } as any,
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "/create Help me keep track of open customer support items.",
      createPipelineRequest: request,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    });

    expect(turn.status).toBe("completed");
    expect(turn.providerTurnId).toBeNull();
    expect(plannerCalls).toHaveLength(1);
    expect(plannerCalls[0].request.id).toBe(request.id);
    expect(turn.createPipeline?.state).toBe("awaiting_plan_approval");
    expect(turn.createPipeline?.plan?.metadata.actionShapeDecisionSource).toBe("model_planner");
    expect(approvals).toHaveLength(1);
    expect(events.some((event) => event.name === "create_pipeline.updated" && event.output === "Create planner is preparing the plan.")).toBe(true);
    expect(events.some((event) => event.name === "turn.completed")).toBe(true);
  });

  test("server create turns persist a blocked create snapshot when planning fails", async () => {
    let session = baseSession();
    const turns: any[] = [];
    const events: any[] = [];
    const approvals: any[] = [];
    const request = createPipelineRequest();

    const runner = createTurnRunner({
      attachmentRootDir: await mkdtemp(join(tmpdir(), "openpond-create-planner-fail-")),
      store: {
        async snapshot() {
          return { events, turns, approvals };
        },
        async getTurn(turnId: string) {
          return turns.find((candidate) => candidate.id === turnId) ?? null;
        },
        async insertTurn(turn: any) {
          turns.push(turn);
        },
        async updateTurn(turnId: string, updater: (turn: any) => any) {
          const index = turns.findIndex((candidate) => candidate.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]);
          return turns[index];
        },
        async getApproval(approvalId: string) {
          return approvals.find((candidate) => candidate.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval: any) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId: string, patch: Record<string, unknown>) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId: string, turnId: string, providerTurnId: string | null = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-07-01T00:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session: any, turnId: string, message: string) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "failed", error: message });
        session = { ...session, status: "failed" };
        return turn;
      },
      interruptTurn: async (_session: any, turnId: string) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("apps should not load for create planning");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("source runtime should not start before plan approval");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => {
        throw new Error("workspace diff should not run during create planning");
      },
      appendRuntimeEvent: async (event: any) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tools should not run during create planning");
      },
      loadPersonalizationSoul: async () => {
        throw new Error("normal chat personalization should not load during create planning");
      },
      maybeCreateScaffoldForTurn: async () => {
        throw new Error("normal chat scaffold should not run during create planning");
      },
      hostedSystemPrompt: async () => {
        throw new Error("normal chat prompt should not build during create planning");
      },
      appendAssistantText: async () => undefined,
      appendHostedContextUsage: async () => undefined,
      planCreatePipeline: async () => {
        throw new Error("questions[1].kind invalid: expected single_choice or free_text");
      },
      turnFollowUpQueue: {
        enqueue() {
          return { id: "unused" };
        },
      } as any,
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "/create Create a one-click social search summary for OpenPond.",
      createPipelineRequest: request,
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.createPipeline?.state).toBe("blocked");
    expect(turn.createPipeline?.blockedReason).toContain("Create planner failed");
    expect(turn.createPipeline?.blockedReason).toContain("questions[1].kind invalid");
    expect(
      events.some(
        (event) =>
          event.name === "create_pipeline.updated" &&
          event.status === "failed" &&
          event.data?.createPipeline?.state === "blocked",
      ),
    ).toBe(true);
  });
});

function createPipelineRequest() {
  return CreatePipelineRequestSchema.parse({
    schemaVersion: "openpond.createPipeline.request.v1",
    id: "create_request_support_items",
    operation: "create",
    surface: "direct_prompt_create",
    command: "/create",
    objective: "Help me keep track of open customer support items.",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/profiles/default-repo",
      sourcePath: "/profiles/default-repo/profiles/default",
      localHead: "abc123",
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "sam", kind: "user", label: "Sam" },
    scope: {
      conversationId: "session_1",
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [],
    },
    targetAgent: {
      agentId: null,
      displayName: null,
      defaultActionKey: "chat",
    },
    metadata: { source: "web_composer_slash" },
    createdAt: now,
  });
}

function baseSession() {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    title: "New chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    cwd: null,
    codexThreadId: null,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  } as any;
}
