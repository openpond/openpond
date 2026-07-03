import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CreatePipelineRequestSchema, emptyOpenPondProfileState } from "@openpond/contracts";
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

  test("native openpond_create_pipeline tool starts the existing create planner path", async () => {
    let session = baseSession({
      provider: "openrouter",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      cwd: "/workspace/current",
    });
    const turns: any[] = [];
    const events: any[] = [];
    const approvals: any[] = [];
    const plannerCalls: any[] = [];
    let streamCalls = 0;
    let providedToolNames: string[] = [];

    const runner = createTurnRunner({
      attachmentRootDir: await mkdtemp(join(tmpdir(), "openpond-create-tool-")),
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
        throw new Error("apps should not load for create tool test");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("source runtime should not start before plan approval");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event: any) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tools should not run for create tool test");
      },
      loadOpenPondProfileState: async () => ({
        ...emptyOpenPondProfileState(),
        mode: "local",
        repoPath: "/profiles/default-repo",
        activeProfile: "default",
        sourcePath: "/profiles/default-repo/profiles/default",
        git: {
          isRepo: true,
          branch: "main",
          head: "abc123",
          shortHead: "abc123",
          dirty: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          remoteUrl: null,
          files: [],
          error: null,
        },
      }),
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (current) => current,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (currentSession, turnId, text) => {
        events.push({
          sessionId: currentSession.id,
          turnId,
          name: "assistant.delta",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        streamCalls += 1;
        if (streamCalls === 1) {
          providedToolNames = (input.tools ?? []).map((tool: any) => tool.function.name);
          yield {
            toolCalls: [
              {
                id: "call_create",
                type: "function",
                function: {
                  name: "openpond_create_pipeline",
                  arguments: JSON.stringify({
                    operation: "create",
                    objective: "Create a support triage agent.",
                    source: "natural_language",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield { text: "Create Pipeline plan is ready for review." };
      },
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
              agentId: "support-triage",
              agentName: "Support Triage",
              summary: "Create a support triage agent.",
              capturedContextSummary: "Natural-language native tool request.",
              actionShape: {
                mode: "chat",
                label: "Chat only",
                detail: "Expose support triage through chat.",
                defaultActionKey: "chat",
                directActionHint: null,
                artifactPolicy: "Persist trace and run summary.",
              },
              sourcePlan: [
                {
                  path: "agents/support-triage",
                  operation: "create",
                  reason: "Implement the support triage agent.",
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
      maxHostedWorkspaceToolRounds: 3,
      maxRepeatedInvalidToolRequests: 1,
      hostedToolFlags: {
        toolMode: "native",
        nativeToolTransport: true,
        resourceTools: true,
        webSearchTool: false,
        dynamicActionTools: false,
        textToolFallback: false,
      },
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "Create a support triage agent.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(providedToolNames).toContain("openpond_create_pipeline");
    expect(plannerCalls).toHaveLength(1);
    expect(plannerCalls[0].request).toMatchObject({
      operation: "create",
      command: "/create",
      objective: "Create a support triage agent.",
      adapter: {
        kind: "local",
        sourceAuthority: "local_profile",
        repoPath: "/profiles/default-repo",
        sourcePath: "/profiles/default-repo/profiles/default",
        localHead: "abc123",
      },
      metadata: {
        source: "native_model_tool",
        toolName: "openpond_create_pipeline",
        routingSource: "natural_language",
      },
    });
    expect(turn.createPipeline?.state).toBe("awaiting_plan_approval");
    expect(turn.createPipelineRequest?.id).toBe(plannerCalls[0].request.id);
    expect(approvals).toHaveLength(1);
    expect(events.some((event) => event.name === "tool.completed" && event.action === "openpond_create_pipeline")).toBe(true);
    expect(events.some((event) => event.name === "create_pipeline.updated" && event.output === "Create planner is preparing the plan.")).toBe(true);
    expect(events.some((event) => event.name === "create_pipeline.updated" && event.data?.createPipeline?.state === "awaiting_plan_approval")).toBe(true);
  });

  test("native openpond_create_pipeline edit uses the selected agent target", async () => {
    const result = await runNativeCreatePipelineToolHarness({
      sessionOverrides: {
        provider: "openrouter",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
        appId: "agent_support",
        appName: "Support Agent",
      },
      toolArgs: {
        operation: "edit",
        objective: "Add escalation summaries.",
      },
    });

    expect(result.turn.status).toBe("completed");
    expect(result.plannerCalls).toHaveLength(1);
    expect(result.plannerCalls[0].request).toMatchObject({
      operation: "edit",
      command: "/edit",
      surface: "direct_prompt_edit",
      targetAgent: {
        agentId: "agent_support",
        displayName: "Support Agent",
        defaultActionKey: "agent_support.chat",
      },
    });
    expect(result.turn.createPipeline?.state).toBe("awaiting_plan_approval");
  });

  test("native openpond_create_pipeline edit fails without a selected or explicit target", async () => {
    const result = await runNativeCreatePipelineToolHarness({
      sessionOverrides: {
        provider: "openrouter",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      },
      toolArgs: {
        operation: "edit",
        objective: "Add escalation summaries.",
      },
    });

    expect(result.turn.status).toBe("completed");
    expect(result.plannerCalls).toHaveLength(0);
    expect(result.events.some(
      (event) =>
        event.name === "tool.completed" &&
        event.action === "openpond_create_pipeline" &&
        event.status === "failed" &&
        String(event.output).includes("requires targetAgentId"),
    )).toBe(true);
  });

  test("native openpond_create_pipeline rejects empty objectives before planning", async () => {
    const result = await runNativeCreatePipelineToolHarness({
      sessionOverrides: {
        provider: "openrouter",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      },
      toolArgs: {
        operation: "create",
        objective: "   ",
      },
    });

    expect(result.turn.status).toBe("completed");
    expect(result.plannerCalls).toHaveLength(0);
    expect(result.events.some(
      (event) =>
        event.name === "tool.completed" &&
        event.action === "openpond_create_pipeline" &&
        event.status === "failed" &&
        String(event.output).includes("objective is required"),
    )).toBe(true);
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

function baseSession(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  } as any;
}

async function runNativeCreatePipelineToolHarness(input: {
  sessionOverrides: Record<string, unknown>;
  toolArgs: Record<string, unknown>;
}) {
  let session = baseSession({
    cwd: "/workspace/current",
    ...input.sessionOverrides,
  });
  const turns: any[] = [];
  const events: any[] = [];
  const approvals: any[] = [];
  const plannerCalls: any[] = [];
  let streamCalls = 0;

  const runner = createTurnRunner({
    attachmentRootDir: await mkdtemp(join(tmpdir(), "openpond-create-tool-harness-")),
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
      throw new Error("apps should not load for create tool harness");
    },
    resolveSessionWorkspaceCwd: async () => null,
    ensureCodexRuntime: async () => {
      throw new Error("source runtime should not start before plan approval");
    },
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (event: any) => {
      events.push(event);
    },
    executeWorkspaceTool: async () => {
      throw new Error("workspace tools should not run for create tool harness");
    },
    loadOpenPondProfileState: async () => ({
      ...emptyOpenPondProfileState(),
      mode: "local",
      repoPath: "/profiles/default-repo",
      activeProfile: "default",
      sourcePath: "/profiles/default-repo/profiles/default",
      git: {
        isRepo: true,
        branch: "main",
        head: "abc123",
        shortHead: "abc123",
        dirty: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        remoteUrl: null,
        files: [],
        error: null,
      },
    }),
    loadPersonalizationSoul: async () => "",
    maybeCreateScaffoldForTurn: async (current) => current,
    hostedSystemPrompt: async () => "System prompt",
    appendAssistantText: async (currentSession, turnId, text) => {
      events.push({
        sessionId: currentSession.id,
        turnId,
        name: "assistant.delta",
        source: "provider",
        output: text,
      });
    },
    appendHostedContextUsage: async () => undefined,
    streamLocalByokChatTurn: async function* () {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          toolCalls: [
            {
              id: "call_create",
              type: "function",
              function: {
                name: "openpond_create_pipeline",
                arguments: JSON.stringify(input.toolArgs),
              },
            },
          ],
        };
        return;
      }
      yield { text: "Done." };
    },
    planCreatePipeline: async (plannerInput) => {
      plannerCalls.push(plannerInput);
      return createPipelineSnapshotFromPlannerDecision({
        request: plannerInput.request,
        previousSnapshot: plannerInput.previousSnapshot,
        modelRef: plannerInput.modelRef,
        decision: {
          schemaVersion: "openpond.createPipeline.plannerDecision.v1",
          decision: "plan",
          plan: {
            agentId: "support-triage",
            agentName: "Support Triage",
            summary: "Create or edit a support triage agent.",
            capturedContextSummary: "Natural-language native tool request.",
            actionShape: {
              mode: "chat",
              label: "Chat only",
              detail: "Expose support triage through chat.",
              defaultActionKey: "chat",
              directActionHint: null,
              artifactPolicy: "Persist trace and run summary.",
            },
            sourcePlan: [
              {
                path: "agents/support-triage",
                operation: input.toolArgs.operation === "edit" ? "update" : "create",
                reason: "Apply the requested support triage change.",
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
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 1,
    hostedToolFlags: {
      toolMode: "native",
      nativeToolTransport: true,
      resourceTools: true,
      webSearchTool: false,
      dynamicActionTools: false,
      textToolFallback: false,
    },
  });

  const turn = await runner.sendTurn("session_1", {
    prompt: "Create or edit a support triage agent.",
    modelRef: session.modelRef,
  });

  return { turn, events, approvals, plannerCalls };
}
