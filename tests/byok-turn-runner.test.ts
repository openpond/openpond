import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import { emptyOpenPondProfileState, type Approval, type RuntimeEvent, type Session, type Turn } from "../packages/contracts/src";
import { runProfileSkillCommand, runProfileSkillGoalCommand } from "../packages/cloud/src/profile/profile-skill-mutations";
import { loadProfileSkills, readProfileSkill } from "../packages/cloud/src/profile/profile-skills";

describe("BYOK turn runner dispatch", () => {
  test("routes profile skill creation through a goal and loads an existing skill from another chat", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-skill-chat-proof-"));
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const profileSourcePath = path.join(repoPath, "profiles", "default");
      const loadTempProfileState = async () => {
        const skillResult = await loadProfileSkills(profileSourcePath);
        return {
          ...emptyOpenPondProfileState(),
          mode: "local" as const,
          repoPath,
          sourcePath: profileSourcePath,
          skills: skillResult.skills,
          skillCatalog: skillResult.skillCatalog,
        };
      };

      const sessions = new Map<string, Session>([
        ["session_create", baseSession({ id: "session_create", title: "Create skill" })],
        ["session_use", baseSession({ id: "session_use", title: "Use skill" })],
      ]);
      const turns: Turn[] = [];
      const events: RuntimeEvent[] = [];
      const approvals: Approval[] = [];
      let capturedSystemOptions: any = null;
      let capturedCreateMessages: Array<{ role: string; content: string }> = [];

      const runner = createTurnRunner({
        attachmentRootDir: "/tmp/openpond-test-attachments",
        store: {
          async snapshot() {
            return { events, turns };
          },
          async getTurn(turnId) {
            return turns.find((turn) => turn.id === turnId) ?? null;
          },
          async insertTurn(turn) {
            turns.push(turn);
          },
          async updateTurn(turnId, updater) {
            const index = turns.findIndex((turn) => turn.id === turnId);
            if (index === -1) return null;
            turns[index] = updater(turns[index]!);
            return turns[index]!;
          },
          async getApproval(approvalId) {
            return approvals.find((approval) => approval.id === approvalId) ?? null;
          },
        },
        upsertApproval: async (approval) => {
          const index = approvals.findIndex((candidate) => candidate.id === approval.id);
          if (index === -1) approvals.push(approval);
          else approvals[index] = approval;
        },
        getSession: async (sessionId) => {
          const session = sessions.get(sessionId);
          if (!session) throw new Error(`unknown session ${sessionId}`);
          return session;
        },
        updateSession: async (sessionId, patch) => {
          const current = sessions.get(sessionId);
          if (!current) throw new Error(`unknown session ${sessionId}`);
          const next = { ...current, ...patch };
          sessions.set(sessionId, next);
          return next;
        },
        completeTurn: async (sessionId, turnId, providerTurnId = null) => {
          const turn = turns.find((candidate) => candidate.id === turnId);
          if (!turn) throw new Error("turn not found");
          Object.assign(turn, {
            providerTurnId,
            completedAt: "2026-07-03T10:00:01.000Z",
            status: "completed",
          });
          const current = sessions.get(sessionId);
          if (current) sessions.set(sessionId, { ...current, status: "idle" });
          return turn;
        },
        failTurn: async (_session, turnId, message) => {
          const turn = turns.find((candidate) => candidate.id === turnId);
          if (!turn) throw new Error("turn not found");
          Object.assign(turn, { status: "failed", error: message });
          return turn;
        },
        interruptTurn: async (_session, turnId) => {
          const turn = turns.find((candidate) => candidate.id === turnId);
          if (!turn) throw new Error("turn not found");
          Object.assign(turn, { status: "interrupted" });
          return turn;
        },
        defaultSessionCwd: () => "/tmp/openpond",
        findOpenPondApp: async () => {
          throw new Error("no app lookup expected");
        },
        resolveSessionWorkspaceCwd: async () => null,
        ensureCodexRuntime: async () => {
          throw new Error("Codex runtime should not be used for BYOK providers");
        },
        appendWorkspaceDiffEvent: async () => undefined,
        workspaceDiffBaseline: async () => null,
        appendRuntimeEvent: async (event) => {
          events.push(event);
        },
        executeWorkspaceTool: async () => {
          throw new Error("workspace tool execution should not be needed");
        },
        executeProfileSkillCommand: ({ prompt }) => runProfileSkillCommand(prompt, { loadProfileState: loadTempProfileState }),
        loadOpenPondProfileState: loadTempProfileState,
        readOpenPondProfileSkill: readProfileSkill,
        loadPersonalizationSoul: async () => "",
        maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
        hostedSystemPrompt: async (_base, _soul, _session, options) => {
          capturedSystemOptions = options;
          return "System prompt";
        },
        appendAssistantText: async (nextSession, turnId, text) => {
          events.push({
            id: `assistant_${events.length}`,
            sessionId: nextSession.id,
            turnId,
            name: "assistant.delta",
            timestamp: "2026-07-03T10:00:00.000Z",
            source: "provider",
            output: text,
          });
        },
        appendHostedContextUsage: async () => {
          throw new Error("hosted context usage should not be recorded for BYOK providers");
        },
        streamLocalByokChatTurn: async function* (input) {
          if (capturedCreateMessages.length === 0) {
            capturedCreateMessages = input.messages;
          }
          const skillName = capturedSystemOptions?.loadedProfileSkills?.[0]?.name ?? "missing-skill";
          yield { text: `Used ${skillName}.`, raw: { ok: true } };
        },
        turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up" }),
        maxHostedWorkspaceToolRounds: 1,
        maxRepeatedInvalidToolRequests: 1,
      });

      const createTurn = await runner.sendTurn("session_create", {
        prompt: "/skill create support-handoff-summaries Draft support handoff summaries.",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      expect(createTurn.status).toBe("completed");
      expect(sessions.get("session_create")?.cwd).toBe(repoPath);
      expect(capturedCreateMessages.at(-1)?.content).toContain("<profile_skill_goal>");
      expect(capturedCreateMessages.at(-1)?.content).toContain("profiles/default/skills/support-handoff-summaries/SKILL.md");
      expect(events.some((event) =>
        event.sessionId === "session_create" &&
        event.name === "diagnostic" &&
        (event.data as any)?.kind === "thread_goal" &&
        (event.data as any)?.goal?.kind === "profile_skill_create"
      )).toBe(true);

      const skillPath = path.join(profileSourcePath, "skills", "support-handoff-summaries", "SKILL.md");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(
        skillPath,
        [
          "---",
          "name: support-handoff-summaries",
          "description: Draft support handoff summaries from customer escalations.",
          "---",
          "",
          "Use this skill for support handoff summaries.",
          "",
        ].join("\n"),
        "utf8",
      );

      const useTurn = await runner.sendTurn("session_use", {
        prompt: "Use $support-handoff-summaries for this customer escalation.",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      expect(useTurn.status).toBe("completed");
      expect(capturedSystemOptions?.openPondProfileSkills?.some((skill: any) => skill.name === "support-handoff-summaries")).toBe(true);
      expect(capturedSystemOptions?.loadedProfileSkills?.[0]).toMatchObject({
        name: "support-handoff-summaries",
        body: expect.stringContaining("support handoff summaries"),
      });
      expect(events.some((event) =>
        event.sessionId === "session_use" &&
        event.name === "skill.selected" &&
        (event.data as any)?.skillName === "support-handoff-summaries"
      )).toBe(true);
      expect(events.some((event) =>
        event.sessionId === "session_use" &&
        event.name === "skill.loaded" &&
        (event.data as any)?.skillName === "support-handoff-summaries"
      )).toBe(true);
      expect(events.some((event) =>
        event.sessionId === "session_use" &&
        event.name === "assistant.delta" &&
        event.output === "Used support-handoff-summaries."
      )).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("routes OpenAI-compatible providers through local BYOK stream", async () => {
    let session = baseSession();
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    let capturedStreamInput: {
      providerId: string;
      modelId?: string | null;
      messages: Array<{ role: string; content: string }>;
    } | null = null;
    let capturedSystemOptions: any = null;

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: {
        async snapshot() {
          return { events, turns };
        },
        async getTurn(turnId) {
          return turns.find((turn) => turn.id === turnId) ?? null;
        },
        async insertTurn(turn) {
          turns.push(turn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((turn) => turn.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]!);
          return turns[index]!;
        },
        async getApproval(approvalId) {
          return approvals.find((approval) => approval.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("no app lookup expected");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be used for BYOK providers");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tool execution should not be needed");
      },
      loadOpenPondProfileState: async () => ({
        ...emptyOpenPondProfileState(),
        mode: "local",
        sourcePath: "/tmp/openpond-profile/profiles/default",
        skills: [
          {
            name: "release-notes",
            description: "Draft release notes.",
            path: "skills/release-notes/SKILL.md",
            scope: "profile",
            enabled: true,
            sourcePath: "/tmp/openpond-profile/profiles/default",
            charCount: 120,
            sourceHash: "d".repeat(64),
            validationStatus: "valid",
            validationMessages: [],
          },
        ],
        skillCatalog: {
          skillCount: 1,
          generatedAt: "2026-07-03T00:00:00.000Z",
          stale: false,
          error: null,
        },
      }),
      readOpenPondProfileSkill: async ({ name }) => ({
        name,
        description: "Draft release notes.",
        body: "Write customer-facing release notes.",
        path: "skills/release-notes/SKILL.md",
        sourceHash: "d".repeat(64),
        charCount: 120,
      }),
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async (_base, _soul, _session, options) => {
        capturedSystemOptions = options;
        return "System prompt";
      },
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => {
        throw new Error("hosted context usage should not be recorded for BYOK providers");
      },
      streamLocalByokChatTurn: async function* (input) {
        capturedStreamInput = {
          providerId: input.providerId,
          modelId: input.modelId,
          messages: input.messages,
        };
        yield { text: "BYOK hello", raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "hello $release-notes",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(turn.providerTurnId).toBe(`openrouter-${turn.id}`);
    expect(turn.modelRef).toEqual({ providerId: "openrouter", modelId: "test/model" });
    expect(session.provider).toBe("openrouter");
    expect(capturedStreamInput).toMatchObject({
      providerId: "openrouter",
      modelId: "test/model",
    });
    expect(capturedStreamInput?.messages).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "hello $release-notes" },
    ]);
    expect(capturedSystemOptions?.openPondProfileSkills?.[0]?.name).toBe("release-notes");
    expect(capturedSystemOptions?.loadedProfileSkills?.[0]).toMatchObject({
      name: "release-notes",
      body: "Write customer-facing release notes.",
    });
    expect(events.some((event) => event.name === "skill.selected" && (event.data as any)?.skillName === "release-notes")).toBe(true);
    expect(events.some((event) => event.name === "skill.loaded" && (event.data as any)?.skillName === "release-notes")).toBe(true);
    expect(events.some((event) => event.name === "assistant.delta" && event.output === "BYOK hello")).toBe(true);
    expect(events.some((event) => event.name === "turn.completed" && event.source === "provider")).toBe(true);
  });

  test("rejects broad legacy text fallback actions when native resource tools are active", async () => {
    let session = baseSession({ workspaceKind: "local_project" });
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const streamInputs: any[] = [];
    let streamPass = 0;

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: {
        async snapshot() {
          return { events, turns };
        },
        async getTurn(turnId) {
          return turns.find((turn) => turn.id === turnId) ?? null;
        },
        async insertTurn(turn) {
          turns.push(turn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((turn) => turn.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]!);
          return turns[index]!;
        },
        async getApproval(approvalId) {
          return approvals.find((approval) => approval.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("no app lookup expected");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be used for BYOK providers");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("broad legacy fallback action should not execute");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async (_base, _soul, _session, options) => {
        expect(options?.toolInstructionMode).toBe("resource_text_fallback");
        return "System prompt";
      },
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        streamInputs.push(input);
        streamPass += 1;
        if (streamPass === 1) {
          yield {
            text: '```openpond_tool\n{"action":"read_files","args":{"paths":["package.json"]}}\n```',
            raw: { pass: 1 },
          };
          return;
        }
        yield { text: "Recovered without a broad fallback action.", raw: { pass: 2 } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-denied-text-fallback" }),
      maxHostedWorkspaceToolRounds: 2,
      maxRepeatedInvalidToolRequests: 1,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "hello",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(streamInputs).toHaveLength(2);
    expect(streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("not available in this mode"),
      }),
    );
    expect(events.some((event) => event.name === "assistant.delta" && event.output === "Recovered without a broad fallback action.")).toBe(true);
  });

  test("executes native resource, web, and scoped action tools before continuing the BYOK turn", async () => {
    let session = baseSession({ workspaceKind: "local_project" });
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [
      {
        id: "goal_event",
        sessionId: "session_1",
        turnId: "turn_prior",
        name: "diagnostic",
        timestamp: "2026-06-30T09:59:00.000Z",
        source: "server",
        output: "Keep native resource refs durable.",
        data: {
          kind: "thread_goal",
          goal: {
            id: "goal_1",
            objective: "Keep native resource refs durable.",
            status: "active",
          },
        },
      },
    ];
    const approvals: Approval[] = [];
    const streamInputs: any[] = [];
    const workspaceToolPayloads: unknown[] = [];
    const webSearchRequests: unknown[] = [];
    let streamPass = 0;

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: {
        async snapshot() {
          return { events, turns };
        },
        async getTurn(turnId) {
          return turns.find((turn) => turn.id === turnId) ?? null;
        },
        async insertTurn(turn) {
          turns.push(turn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((turn) => turn.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]!);
          return turns[index]!;
        },
        async getApproval(approvalId) {
          return approvals.find((approval) => approval.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("no app lookup expected");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be used for BYOK providers");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async (_sessionId, payload) => {
        workspaceToolPayloads.push(payload);
        if ((payload as any).action === "sandbox_run_action") {
          return {
            ok: true,
            action: "sandbox_run_action",
            appId: null,
            output: "Ran deploy.",
            data: { action: { name: "deploy" }, command: { status: "completed", output: "ok" } },
          };
        }
        return {
          ok: true,
          action: "resource_search",
          appId: null,
          output: "Found 1 resource.",
          data: {
            result: {
              query: "README",
              scope: "workspace",
              items: [{ ref: "workspace:file:README.md", title: "README.md", metadata: {} }],
              truncated: false,
            },
          },
        };
      },
      executeWebSearch: async (request) => {
        webSearchRequests.push(request);
        return {
          query: request.query,
          provider: "test",
          searchedAt: "2026-07-02T10:00:00.000Z",
          results: [
            {
              id: "result_1",
              title: "OpenPond",
              url: "https://openpond.ai",
              snippet: "OpenPond result",
              sourceName: "OpenPond",
              publishedAt: null,
              updatedAt: null,
            },
          ],
          truncated: false,
        };
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        streamInputs.push(input);
        streamPass += 1;
        if (streamPass === 1) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: "call_resource",
                type: "function",
                function: {
                  name: "resource_search",
                  arguments: '{"scope":"workspace","query":"README"}',
                },
              },
              {
                index: 1,
                id: "call_web",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: '{"query":"OpenPond","limit":1}',
                },
              },
              {
                index: 2,
                id: "call_action",
                type: "function",
                function: {
                  name: "openpond_action_run",
                  arguments: '{"actionId":"deploy","input":{"target":"preview"}}',
                },
              },
              {
                index: 3,
                id: "call_goal",
                type: "function",
                function: {
                  name: "resource_read",
                  arguments: '{"ref":"goal-context:goal_event"}',
                },
              },
            ],
            raw: { pass: 1 },
          };
          yield { finishReason: "tool_calls", raw: { pass: 1 } };
          return;
        }
        yield { text: "README.md is the relevant resource.", raw: { pass: 2 } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-native-tools" }),
      hostedToolFlags: { webSearchTool: true, dynamicActionTools: true },
      maxHostedWorkspaceToolRounds: 3,
      maxRepeatedInvalidToolRequests: 2,
    });

    const turn = await runner.sendTurn("session_1", {
      prompt: "find the README",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      openPondActionCatalog: [
        {
          id: "deploy",
          name: "deploy",
          label: "Deploy",
          description: "Deploy the selected project.",
        },
      ],
    });

    expect(turn.status).toBe("completed");
    expect(streamInputs).toHaveLength(2);
    expect(streamInputs[0].toolChoice).toBe("auto");
    expect(streamInputs[0].tools.map((tool: any) => tool.function.name)).toEqual([
      "openpond_create_pipeline",
      "openpond_goal_control",
      "resource_search",
      "resource_read",
      "web_search",
      "openpond_action_search",
      "openpond_action_run",
    ]);
    expect(streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({
            id: "call_resource",
            function: expect.objectContaining({ name: "resource_search" }),
          }),
          expect.objectContaining({
            id: "call_web",
            function: expect.objectContaining({ name: "web_search" }),
          }),
          expect.objectContaining({
            id: "call_action",
            function: expect.objectContaining({ name: "openpond_action_run" }),
          }),
          expect.objectContaining({
            id: "call_goal",
            function: expect.objectContaining({ name: "resource_read" }),
          }),
        ]),
      }),
    );
    expect(streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_resource",
      }),
    );
    expect(workspaceToolPayloads).toEqual([
      {
        action: "resource_search",
        args: { scope: "workspace", query: "README" },
        source: "chat_action",
      },
      {
        action: "sandbox_run_action",
        args: {
          actionName: "deploy",
          input: { target: "preview" },
        },
        source: "chat_action",
      },
    ]);
    expect(webSearchRequests).toEqual([{ query: "OpenPond", limit: 1 }]);
    expect(events.some((event) => event.name === "tool.started" && event.action === "resource_search")).toBe(true);
    expect(events.some((event) => event.name === "tool.completed" && event.action === "resource_search")).toBe(true);
    expect(events.some((event) => event.name === "tool.started" && event.action === "web_search")).toBe(true);
    expect(events.some((event) => event.name === "tool.completed" && event.action === "web_search")).toBe(true);
    expect(events.some((event) => event.name === "tool.started" && event.action === "openpond_action_run")).toBe(true);
    expect(events.some((event) => event.name === "tool.completed" && event.action === "openpond_action_run")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.name === "tool.completed" &&
          event.action === "resource_read" &&
          Array.isArray((event.data as any)?.resourceRefs) &&
          (event.data as any).resourceRefs.includes("goal-context:goal_event"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.name === "assistant.delta" && event.output === "README.md is the relevant resource.")).toBe(true);
  });

  test("executes native profile skill goal tool through the BYOK tool loop", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-skill-native-tool-"));
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const profileSourcePath = path.join(repoPath, "profiles", "default");
      await mkdir(profileSourcePath, { recursive: true });
      const harness = createNativeProfileSkillGoalHarness({
        repoPath,
        profileSourcePath,
        toolArgs: {
          operation: "create",
          objective: "Draft support handoff summaries.",
          skillName: "support-handoff-summaries",
          source: "model_tool",
        },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "create me a skill for support handoff summaries",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });

      expect(turn.status).toBe("completed");
      expect(harness.sessions.get("session_1")?.cwd).toBe(repoPath);
      expect(harness.streamInputs).toHaveLength(2);
      expect(harness.streamInputs[0].tools.map((tool: any) => tool.function.name)).toEqual(
        expect.arrayContaining(["openpond_create_pipeline", "openpond_profile_skill_goal"]),
      );
      expect(harness.streamInputs[1].messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_profile_skill_goal",
          content: expect.stringContaining("openpond_profile_skill_goal"),
        }),
      );
      const completed = harness.events.find(
        (event) => event.name === "tool.completed" && event.action === "openpond_profile_skill_goal",
      );
      expect(completed).toMatchObject({
        status: "completed",
      });
      expect((completed?.data as any)?.result).toMatchObject({
        operation: "create",
        targetSkillName: "support-handoff-summaries",
        targetSkillPath: "profiles/default/skills/support-handoff-summaries/SKILL.md",
        status: "queued",
      });
      expect((completed?.data as any)?.result?.goalPrompt).toContain("<profile_skill_goal>");
      expect((completed?.data as any)?.result?.goalPrompt).toContain("Keep the skill package single-file: only SKILL.md.");
      expect(harness.events.some(
        (event) =>
          event.name === "diagnostic" &&
          (event.data as any)?.kind === "profile_skill_command" &&
          (event.data as any)?.routing === "goal" &&
          (event.data as any)?.source === "model_tool" &&
          (event.data as any)?.goal?.targetSkillName === "support-handoff-summaries",
      )).toBe(true);
      expect(harness.events.some(
        (event) =>
          event.name === "diagnostic" &&
          (event.data as any)?.kind === "thread_goal" &&
          (event.data as any)?.provider === "openpond" &&
          (event.data as any)?.goal?.kind === "profile_skill_create",
      )).toBe(true);
      expect(harness.events.some(
        (event) =>
          event.name === "tool.started" &&
          event.action === "openpond_profile_skill_goal" &&
          (event.args as any)?.skillName === "support-handoff-summaries",
      )).toBe(true);
      expect(harness.events.some(
        (event) => event.name === "assistant.delta" && event.output === "Profile skill route handled.",
      )).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects native profile skill goals that need agent-style assets or setup", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-skill-agent-reject-"));
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const profileSourcePath = path.join(repoPath, "profiles", "default");
      await mkdir(profileSourcePath, { recursive: true });
      const harness = createNativeProfileSkillGoalHarness({
        repoPath,
        profileSourcePath,
        toolArgs: {
          operation: "create",
          objective: "Create a reusable workflow with references/ files and a setup command.",
          skillName: "external-workflow",
          source: "model_tool",
        },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "create me a skill with reference files and setup",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });

      expect(turn.status).toBe("completed");
      expect(harness.sessions.get("session_1")?.cwd).not.toBe(repoPath);
      const completed = harness.events.find(
        (event) => event.name === "tool.completed" && event.action === "openpond_profile_skill_goal",
      );
      expect(completed).toMatchObject({
        status: "failed",
      });
      expect(completed?.output).toContain("Profile skills are single-file instructions");
      expect(completed?.output).toContain("Create an agent instead");
      expect(harness.events.some(
        (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
      )).toBe(false);
      expect(harness.streamInputs[1].messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_profile_skill_goal",
          content: expect.stringContaining("\"ok\": false"),
        }),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("restarts the current OpenPond goal through native goal control", async () => {
    const harness = createNativeGoalControlHarness({
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-goal-workspace",
      },
      initialEvents: [
        {
          id: "goal_event",
          sessionId: "session_1",
          turnId: "turn_prior",
          name: "diagnostic",
          timestamp: "2026-07-03T09:59:00.000Z",
          source: "provider",
          status: "completed",
          output: "Ship the goal-control tool.",
          data: {
            kind: "thread_goal",
            provider: "openpond",
            goal: {
              id: "goal_1",
              provider: "openpond",
              objective: "Ship the goal-control tool.",
              status: "blocked",
              mode: "local",
              timeUsedSeconds: 20,
              tokensUsed: 100,
            },
          },
        },
      ],
      toolArgs: {
        action: "restart",
        targetGoalId: "goal_1",
        reason: "User asked to restart the selected goal.",
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "restart this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.streamInputs[0].tools.map((tool: any) => tool.function.name)).toContain("openpond_goal_control");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect(completed).toMatchObject({
      status: "completed",
    });
    expect((completed?.data as any)?.result).toMatchObject({
      goalId: "goal_1",
      action: "restart",
      status: "queued",
      objective: "Ship the goal-control tool.",
      mode: "local",
    });
    const control = harness.events.find(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "goal_control",
    );
    expect(control?.output).toBe("OpenPond goal restarted.");
    expect((control?.data as any)?.goal).toMatchObject({
      id: "goal_1",
      status: "queued",
      previousStatus: "blocked",
      controlAction: "restart",
      timeUsedSeconds: 20,
      tokensUsed: 100,
    });
    expect((control?.data as any)?.previousGoal).toMatchObject({
      id: "goal_1",
      status: "blocked",
    });
    const latestThreadGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestThreadGoal?.data as any)?.goal).toMatchObject({
      id: "goal_1",
      status: "queued",
      objective: "Ship the goal-control tool.",
      controlAction: "restart",
    });
  });

  test("returns a failed goal-control tool result when the target goal is ambiguous", async () => {
    const harness = createNativeGoalControlHarness({
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-goal-workspace",
      },
      toolArgs: {
        action: "restart",
        reason: "User asked to restart this goal.",
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "restart this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    expect(completed).toMatchObject({
      status: "failed",
    });
    expect(completed?.output).toContain("No current OpenPond goal was found");
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "goal_control",
    )).toBe(false);
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )).toBe(false);
  });

  test("does not hard-route conceptual create or skill questions into workflow tools", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-goal-workspace",
      },
      finalText: "This is a conceptual answer, not a workflow start.",
    });

    for (const prompt of ["how do I create an agent?", "should this be a skill or an agent?"]) {
      const turn = await harness.runner.sendTurn("session_1", {
        prompt,
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      expect(turn.status).toBe("completed");
    }

    expect(harness.streamInputs).toHaveLength(2);
    for (const streamInput of harness.streamInputs) {
      expect(streamInput.tools.map((tool: any) => tool.function.name)).toEqual(
        expect.arrayContaining(["openpond_create_pipeline", "openpond_goal_control"]),
      );
    }
    expect(harness.events.some((event) => event.name === "create_pipeline.updated")).toBe(false);
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "profile_skill_command",
    )).toBe(false);
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "goal_control",
    )).toBe(false);
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )).toBe(false);
  });

  test("allows concurrent turns in different sessions while rejecting duplicate turns in one session", async () => {
    const sessions = new Map<string, Session>([
      ["session_1", baseSession()],
      ["session_2", baseSession({ id: "session_2", title: "Second BYOK chat" })],
    ]);
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const firstStreamStarted = deferred();
    const secondStreamStarted = deferred();
    const releaseStreams = deferred();
    let streamStarts = 0;

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: {
        async snapshot() {
          return { events, turns };
        },
        async getTurn(turnId) {
          return turns.find((turn) => turn.id === turnId) ?? null;
        },
        async insertTurn(turn) {
          turns.push(turn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((turn) => turn.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]!);
          return turns[index]!;
        },
        async getApproval(approvalId) {
          return approvals.find((approval) => approval.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async (sessionId) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        return session;
      },
      updateSession: async (sessionId, patch) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        const next = { ...session, ...patch };
        sessions.set(sessionId, next);
        return next;
      },
      completeTurn: async (sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        const session = sessions.get(sessionId);
        if (session) sessions.set(sessionId, { ...session, status: "idle" });
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("no app lookup expected");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be used for BYOK providers");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tool execution should not be needed");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        streamStarts += 1;
        if (streamStarts === 1) firstStreamStarted.resolve();
        if (streamStarts === 2) secondStreamStarted.resolve();
        await releaseStreams.promise;
        const turn = turns.find((candidate) => candidate.id === input.requestId);
        yield { text: `BYOK done ${turn?.sessionId ?? "unknown"}`, raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-concurrent" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const firstTurnPromise = runner.sendTurn("session_1", {
      prompt: "first",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await firstStreamStarted.promise;

    await expect(
      runner.sendTurn("session_1", {
        prompt: "duplicate",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      }),
    ).rejects.toThrow("A turn is already running for this chat.");

    const secondTurnPromise = runner.sendTurn("session_2", {
      prompt: "second",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await secondStreamStarted.promise;

    releaseStreams.resolve();
    const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);

    expect(firstTurn.status).toBe("completed");
    expect(secondTurn.status).toBe("completed");
    expect(streamStarts).toBe(2);
    expect(turns.map((turn) => turn.prompt).sort()).toEqual(["first", "second"]);
    expect(events.some((event) => event.sessionId === "session_1" && event.output === "BYOK done session_1")).toBe(true);
    expect(events.some((event) => event.sessionId === "session_2" && event.output === "BYOK done session_2")).toBe(true);
  });

  test("allows a follow-up turn after interrupting a still-unwinding active turn", async () => {
    let session = baseSession();
    const turns: Turn[] = [];
    const events: RuntimeEvent[] = [];
    const approvals: Approval[] = [];
    const firstStreamStarted = deferred();
    const secondStreamStarted = deferred();
    const releaseFirstStream = deferred();

    const runner = createTurnRunner({
      attachmentRootDir: "/tmp/openpond-test-attachments",
      store: {
        async snapshot() {
          return { events, turns };
        },
        async getTurn(turnId) {
          return turns.find((turn) => turn.id === turnId) ?? null;
        },
        async insertTurn(turn) {
          turns.push(turn);
        },
        async updateTurn(turnId, updater) {
          const index = turns.findIndex((turn) => turn.id === turnId);
          if (index === -1) return null;
          turns[index] = updater(turns[index]!);
          return turns[index]!;
        },
        async getApproval(approvalId) {
          return approvals.find((approval) => approval.id === approvalId) ?? null;
        },
      },
      upsertApproval: async (approval) => {
        const index = approvals.findIndex((candidate) => candidate.id === approval.id);
        if (index === -1) approvals.push(approval);
        else approvals[index] = approval;
      },
      getSession: async () => session,
      updateSession: async (_sessionId, patch) => {
        session = { ...session, ...patch };
        return session;
      },
      completeTurn: async (_sessionId, turnId, providerTurnId = null) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, {
          providerTurnId,
          completedAt: "2026-06-30T10:00:01.000Z",
          status: "completed",
        });
        session = { ...session, status: "idle" };
        return turn;
      },
      failTurn: async (_session, turnId, message) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "failed", error: message });
        return turn;
      },
      interruptTurn: async (_session, turnId) => {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new Error("turn not found");
        Object.assign(turn, { status: "interrupted" });
        return turn;
      },
      defaultSessionCwd: () => "/tmp/openpond",
      findOpenPondApp: async () => {
        throw new Error("no app lookup expected");
      },
      resolveSessionWorkspaceCwd: async () => null,
      ensureCodexRuntime: async () => {
        throw new Error("Codex runtime should not be used for BYOK providers");
      },
      appendWorkspaceDiffEvent: async () => undefined,
      workspaceDiffBaseline: async () => null,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      executeWorkspaceTool: async () => {
        throw new Error("workspace tool execution should not be needed");
      },
      loadPersonalizationSoul: async () => "",
      maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
      hostedSystemPrompt: async () => "System prompt",
      appendAssistantText: async (nextSession, turnId, text) => {
        events.push({
          id: `assistant_${events.length}`,
          sessionId: nextSession.id,
          turnId,
          name: "assistant.delta",
          timestamp: "2026-06-30T10:00:00.000Z",
          source: "provider",
          output: text,
        });
      },
      appendHostedContextUsage: async () => undefined,
      streamLocalByokChatTurn: async function* (input) {
        const turn = turns.find((candidate) => candidate.id === input.requestId);
        if (turn?.prompt === "first") {
          firstStreamStarted.resolve();
          await releaseFirstStream.promise;
        } else {
          secondStreamStarted.resolve();
        }
        yield { text: `BYOK done ${turn?.prompt ?? "unknown"}`, raw: { ok: true } };
      },
      turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-interrupt" }),
      maxHostedWorkspaceToolRounds: 1,
      maxRepeatedInvalidToolRequests: 1,
    });

    const firstTurnPromise = runner.sendTurn("session_1", {
      prompt: "first",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await firstStreamStarted.promise;

    const interrupted = await runner.interruptSessionTurn("session_1");
    expect(interrupted.status).toBe("interrupted");

    const secondTurnPromise = runner.sendTurn("session_1", {
      prompt: "second",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });
    await secondStreamStarted.promise;

    releaseFirstStream.resolve();
    const [firstTurn, secondTurn] = await Promise.all([firstTurnPromise, secondTurnPromise]);

    expect(firstTurn.status).toBe("interrupted");
    expect(secondTurn.status).toBe("completed");
    expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
  });
});

function createNativeProfileSkillGoalHarness(input: {
  repoPath: string;
  profileSourcePath: string;
  toolArgs: Record<string, unknown>;
  finalText?: string;
}) {
  const sessions = new Map<string, Session>([
    ["session_1", baseSession({ title: "Profile skill native tool" })],
  ]);
  const turns: Turn[] = [];
  const events: RuntimeEvent[] = [];
  const approvals: Approval[] = [];
  const streamInputs: any[] = [];
  let streamPass = 0;
  const loadTempProfileState = async () => {
    const skillResult = await loadProfileSkills(input.profileSourcePath);
    return {
      ...emptyOpenPondProfileState(),
      mode: "local" as const,
      repoPath: input.repoPath,
      sourcePath: input.profileSourcePath,
      activeProfile: "default",
      skills: skillResult.skills,
      skillCatalog: skillResult.skillCatalog,
    };
  };
  const runner = createTurnRunner({
    attachmentRootDir: "/tmp/openpond-test-attachments",
    store: {
      async snapshot() {
        return { events, turns };
      },
      async getTurn(turnId) {
        return turns.find((turn) => turn.id === turnId) ?? null;
      },
      async insertTurn(turn) {
        turns.push(turn);
      },
      async updateTurn(turnId, updater) {
        const index = turns.findIndex((turn) => turn.id === turnId);
        if (index === -1) return null;
        turns[index] = updater(turns[index]!);
        return turns[index]!;
      },
      async getApproval(approvalId) {
        return approvals.find((approval) => approval.id === approvalId) ?? null;
      },
    },
    upsertApproval: async (approval) => {
      const index = approvals.findIndex((candidate) => candidate.id === approval.id);
      if (index === -1) approvals.push(approval);
      else approvals[index] = approval;
    },
    getSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return session;
    },
    updateSession: async (sessionId, patch) => {
      const current = sessions.get(sessionId);
      if (!current) throw new Error(`unknown session ${sessionId}`);
      const next = { ...current, ...patch };
      sessions.set(sessionId, next);
      return next;
    },
    completeTurn: async (sessionId, turnId, providerTurnId = null) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, {
        providerTurnId,
        completedAt: "2026-07-03T10:00:01.000Z",
        status: "completed",
      });
      const current = sessions.get(sessionId);
      if (current) sessions.set(sessionId, { ...current, status: "idle" });
      return turn;
    },
    failTurn: async (_session, turnId, message) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "failed", error: message });
      return turn;
    },
    interruptTurn: async (_session, turnId) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "interrupted" });
      return turn;
    },
    defaultSessionCwd: () => "/tmp/openpond",
    findOpenPondApp: async () => {
      throw new Error("no app lookup expected");
    },
    resolveSessionWorkspaceCwd: async () => null,
    ensureCodexRuntime: async () => {
      throw new Error("Codex runtime should not be used for BYOK providers");
    },
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (event) => {
      events.push(event);
    },
    executeWorkspaceTool: async () => {
      throw new Error("workspace tool execution should not be needed");
    },
    executeProfileSkillGoal: (commandInput) =>
      runProfileSkillGoalCommand(commandInput, { loadProfileState: loadTempProfileState }),
    loadOpenPondProfileState: loadTempProfileState,
    readOpenPondProfileSkill: readProfileSkill,
    loadPersonalizationSoul: async () => "",
    maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
    hostedSystemPrompt: async () => "System prompt",
    appendAssistantText: async (nextSession, turnId, text) => {
      events.push({
        id: `assistant_${events.length}`,
        sessionId: nextSession.id,
        turnId,
        name: "assistant.delta",
        timestamp: "2026-07-03T10:00:00.000Z",
        source: "provider",
        output: text,
      });
    },
    appendHostedContextUsage: async () => undefined,
    streamLocalByokChatTurn: async function* (streamInput) {
      streamInputs.push(streamInput);
      streamPass += 1;
      if (streamPass === 1) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: "call_profile_skill_goal",
              type: "function",
              function: {
                name: "openpond_profile_skill_goal",
                arguments: JSON.stringify(input.toolArgs),
              },
            },
          ],
          raw: { pass: 1 },
        };
        yield { finishReason: "tool_calls", raw: { pass: 1 } };
        return;
      }
      yield { text: input.finalText ?? "Profile skill route handled.", raw: { pass: 2 } };
    },
    turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-profile-skill-native" }),
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 2,
  });
  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    streamInputs,
  };
}

function createNativeGoalControlHarness(input: {
  toolArgs?: Record<string, unknown> | null;
  initialEvents?: RuntimeEvent[];
  sessionOverrides?: Partial<Session>;
  finalText?: string;
}) {
  const sessions = new Map<string, Session>([
    ["session_1", baseSession({ title: "Goal control native tool", ...input.sessionOverrides })],
  ]);
  const turns: Turn[] = [];
  const events: RuntimeEvent[] = [...(input.initialEvents ?? [])];
  const approvals: Approval[] = [];
  const streamInputs: any[] = [];
  let streamPass = 0;
  const runner = createTurnRunner({
    attachmentRootDir: "/tmp/openpond-test-attachments",
    store: {
      async snapshot() {
        return { events, turns };
      },
      async getTurn(turnId) {
        return turns.find((turn) => turn.id === turnId) ?? null;
      },
      async insertTurn(turn) {
        turns.push(turn);
      },
      async updateTurn(turnId, updater) {
        const index = turns.findIndex((turn) => turn.id === turnId);
        if (index === -1) return null;
        turns[index] = updater(turns[index]!);
        return turns[index]!;
      },
      async getApproval(approvalId) {
        return approvals.find((approval) => approval.id === approvalId) ?? null;
      },
    },
    upsertApproval: async (approval) => {
      const index = approvals.findIndex((candidate) => candidate.id === approval.id);
      if (index === -1) approvals.push(approval);
      else approvals[index] = approval;
    },
    getSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return session;
    },
    updateSession: async (sessionId, patch) => {
      const current = sessions.get(sessionId);
      if (!current) throw new Error(`unknown session ${sessionId}`);
      const next = { ...current, ...patch };
      sessions.set(sessionId, next);
      return next;
    },
    completeTurn: async (sessionId, turnId, providerTurnId = null) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, {
        providerTurnId,
        completedAt: "2026-07-03T10:00:01.000Z",
        status: "completed",
      });
      const current = sessions.get(sessionId);
      if (current) sessions.set(sessionId, { ...current, status: "idle" });
      return turn;
    },
    failTurn: async (_session, turnId, message) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "failed", error: message });
      return turn;
    },
    interruptTurn: async (_session, turnId) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "interrupted" });
      return turn;
    },
    defaultSessionCwd: () => "/tmp/openpond",
    findOpenPondApp: async () => {
      throw new Error("no app lookup expected");
    },
    resolveSessionWorkspaceCwd: async () => null,
    ensureCodexRuntime: async () => {
      throw new Error("Codex runtime should not be used for BYOK providers");
    },
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (event) => {
      events.push(event);
    },
    executeWorkspaceTool: async () => {
      throw new Error("workspace tool execution should not be needed");
    },
    loadPersonalizationSoul: async () => "",
    maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
    hostedSystemPrompt: async () => "System prompt",
    appendAssistantText: async (nextSession, turnId, text) => {
      events.push({
        id: `assistant_${events.length}`,
        sessionId: nextSession.id,
        turnId,
        name: "assistant.delta",
        timestamp: "2026-07-03T10:00:00.000Z",
        source: "provider",
        output: text,
      });
    },
    appendHostedContextUsage: async () => undefined,
    streamLocalByokChatTurn: async function* (streamInput) {
      streamInputs.push(streamInput);
      streamPass += 1;
      if (streamPass === 1 && input.toolArgs) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: "call_goal_control",
              type: "function",
              function: {
                name: "openpond_goal_control",
                arguments: JSON.stringify(input.toolArgs),
              },
            },
          ],
          raw: { pass: 1 },
        };
        yield { finishReason: "tool_calls", raw: { pass: 1 } };
        return;
      }
      yield { text: input.finalText ?? "Goal control handled.", raw: { pass: 2 } };
    },
    turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-goal-control-native" }),
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 2,
  });
  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    streamInputs,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "BYOK chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-06-30T10:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
