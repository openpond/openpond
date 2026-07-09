import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import { createContextUsageSnapshot } from "../apps/server/src/openpond/context-usage";
import {
  AppPreferencesSchema,
  ProviderSettingsSchema,
  emptyOpenPondProfileState,
  type Approval,
  type AppPreferences,
  type ModelUsageRecord,
  type ProviderSettings,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "../packages/contracts/src";
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
        prompt: "/skill create support-handoff-summaries: Draft support handoff summaries.",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      expect(createTurn.status).toBe("completed");
      expect(sessions.get("session_create")?.cwd).toBe(repoPath);
      expect(capturedCreateMessages).toHaveLength(0);
      expect(events.some((event) =>
        event.sessionId === "session_create" &&
        event.name === "diagnostic" &&
        (event.data as any)?.kind === "thread_goal" &&
        (event.data as any)?.goal?.kind === "profile_skill_create" &&
        (event.data as any)?.goal?.status === "completed" &&
        (event.data as any)?.goal?.targetSkillName === "support-handoff-summaries"
      )).toBe(true);
      await expect(
        readFile(path.join(profileSourcePath, "skills", "support-handoff-summaries", "SKILL.md"), "utf8"),
      ).resolves.toContain("Draft support handoff summaries.");

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
          messages: input.messages.map((message) => ({ ...message })),
        };
        yield { reasoningText: "The user is saying hello.", raw: { ok: true } };
        yield { text: "BYOK", raw: { ok: true } };
        yield { text: " hello", raw: { ok: true } };
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
    expect(events.some((event) => event.name === "assistant.reasoning.delta" && event.output === "The user is saying hello.")).toBe(true);
    expect(events.some((event) => event.name === "assistant.delta" && event.output?.includes("The user is saying hello."))).toBe(false);
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
      "web_fetch",
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
        usageByPass: {
          1: { prompt_tokens: 22, completion_tokens: 4, total_tokens: 26 },
          2: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
        },
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
        status: "completed",
        validationStatus: "valid",
        invocation: "$support-handoff-summaries",
      });
      const goalId = (completed?.data as any)?.result?.goalId;
      expect(goalId).toMatch(/^goal_/);
      await expect(
        readFile(path.join(profileSourcePath, "skills", "support-handoff-summaries", "SKILL.md"), "utf8"),
      ).resolves.toContain("Draft support handoff summaries.");
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
          (event.data as any)?.goal?.kind === "profile_skill_create" &&
          (event.data as any)?.goal?.status === "completed",
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
      expect(harness.usageRecords).toHaveLength(2);
      expect(harness.usageRecords[0]).toMatchObject({
        requestId: `${turn.id}:model:0`,
        requestOrdinal: 0,
        requestKind: "chat_turn",
        source: "provider_usage",
        totalTokens: 26,
        attribution: {
          workflowKind: "direct_chat",
          goalId: null,
          commandName: null,
        },
      });
      expect(harness.usageRecords[1]).toMatchObject({
        requestId: `${turn.id}:model:1`,
        requestOrdinal: 1,
        requestKind: "goal_control",
        visibility: "background",
        source: "provider_usage",
        promptTokens: 18,
        completionTokens: 6,
        totalTokens: 24,
        attribution: {
          surface: "goal",
          workflowKind: "goal_control",
          goalId,
          commandName: "/skill",
          commandSource: "model_tool",
        },
      });
      expect(harness.turns[0]?.metadata).toMatchObject({
        usageAttribution: {
          goalId,
          commandName: "/skill",
          commandSource: "model_tool",
        },
        threadGoal: {
          id: goalId,
          kind: "profile_skill_create",
          targetSkillName: "support-handoff-summaries",
          status: "completed",
        },
      });
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

  test("fails closed for native profile skill goals in Hybrid sessions", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-skill-hybrid-reject-"));
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const profileSourcePath = path.join(repoPath, "profiles", "default");
      await mkdir(profileSourcePath, { recursive: true });
      const harness = createNativeProfileSkillGoalHarness({
        repoPath,
        profileSourcePath,
        sessionOverrides: {
          workspaceKind: "sandbox",
          workspaceId: "sandbox_hybrid",
          workspaceName: "Hybrid Sandbox",
          cwd: null,
          localProjectId: "local_project_1",
          cloudProjectId: "cloud_project_1",
          cloudTeamId: "team_1",
          metadata: { workspaceTarget: "hybrid" },
        },
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
      expect(harness.sessions.get("session_1")?.cwd).not.toBe(repoPath);
      const completed = harness.events.find(
        (event) => event.name === "tool.completed" && event.action === "openpond_profile_skill_goal",
      );
      expect(completed).toMatchObject({
        status: "failed",
      });
      expect(completed?.output).toContain("Profile skill goals are local profile workspace actions");
      expect(completed?.output).toContain("Working in Hybrid");
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

  test("allows native profile skill goals that explicitly exclude agent-style files", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-skill-negated-agent-terms-"));
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const profileSourcePath = path.join(repoPath, "profiles", "default");
      await mkdir(profileSourcePath, { recursive: true });
      const harness = createNativeProfileSkillGoalHarness({
        repoPath,
        profileSourcePath,
        toolArgs: {
          operation: "create",
          objective: "Create a single SKILL.md tone-check skill with no scripts and no setup files.",
          skillName: "tone-check",
          source: "model_tool",
        },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "create me a profile skill with no scripts or setup files",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });

      expect(turn.status).toBe("completed");
      expect(harness.sessions.get("session_1")?.cwd).toBe(repoPath);
      const completed = harness.events.find(
        (event) => event.name === "tool.completed" && event.action === "openpond_profile_skill_goal",
      );
      expect(completed).toMatchObject({
        status: "completed",
      });
      expect((completed?.data as any)?.result).toMatchObject({
        operation: "create",
        targetSkillName: "tone-check",
        targetSkillPath: "profiles/default/skills/tone-check/SKILL.md",
        status: "completed",
        validationStatus: "valid",
        invocation: "$tone-check",
      });
      await expect(
        readFile(path.join(profileSourcePath, "skills", "tone-check", "SKILL.md"), "utf8"),
      ).resolves.toContain("Create a single SKILL.md tone-check skill");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("queues the first continuation turn when native goal control starts a goal", async () => {
    const harness = createNativeGoalControlHarness({
      enableGoalContinuations: true,
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-goal-workspace",
      },
      toolArgs: {
        action: "start",
        objective: "Implement the lifecycle watcher.",
        mode: "auto",
        reason: "User asked OpenPond to pursue durable work.",
      },
      finalText: "Goal started.",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "start this goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const completed = harness.events.find(
      (event) => event.name === "tool.completed" && event.action === "openpond_goal_control",
    );
    const goalId = (completed?.data as any)?.result?.goalId;
    expect(goalId).toMatch(/^goal_/);

    await harness.turnFollowUpQueue.drain();

    expect(harness.turns).toHaveLength(2);
    const continuationTurn = harness.turns[1]!;
    expect(continuationTurn.status).toBe("completed");
    expect(continuationTurn.prompt).toContain("<goal_context>");
    expect(continuationTurn.prompt).toContain("Implement the lifecycle watcher.");
    expect(continuationTurn.metadata).toMatchObject({
      goalContinuation: {
        goalId,
        sourceTurnId: turn.id,
        action: "start",
      },
      threadGoal: {
        id: goalId,
        status: "queued",
        objective: "Implement the lifecycle watcher.",
      },
    });
    expect(harness.events.some(
      (event) => event.name === "goal.continuation.started" && (event.data as any)?.goalId === goalId,
    )).toBe(true);
    const continuationStream = harness.streamInputs.find((streamInput) =>
      streamInput.messages.some(
        (message: { role?: string; content?: string }) =>
          message.role === "user" && message.content?.includes("Continue the active OpenPond goal now."),
      ),
    );
    expect(continuationStream).toBeTruthy();
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

  test("blocks generic goal control for profile-skill goals without replacing goal metadata", async () => {
    const profileSkillGoal = {
      id: "goal_profile_skill",
      provider: "openpond",
      kind: "profile_skill_create",
      operation: "create",
      objective: "Create a profile-backed skill: clean Docker caches.",
      userObjective: "clean Docker caches.",
      status: "running",
      activeProfile: "default",
      profileRepoPath: "/tmp/profile-repo",
      profileSourcePath: "/tmp/profile-repo/profiles/default",
      profileSourceRelativePath: "profiles/default",
      requestedName: null,
      targetSkillName: "docker-cleanup",
      targetSkillPath: "profiles/default/skills/docker-cleanup/SKILL.md",
    };
    const harness = createNativeGoalControlHarness({
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-goal-workspace",
      },
      initialEvents: [
        {
          id: "profile_skill_goal_event",
          sessionId: "session_1",
          turnId: "turn_prior",
          name: "diagnostic",
          timestamp: "2026-07-03T09:59:00.000Z",
          source: "provider",
          status: "completed",
          output: "Create a profile-backed skill: clean Docker caches.",
          data: {
            kind: "thread_goal",
            provider: "openpond",
            goal: profileSkillGoal,
          },
        },
      ],
      toolArgs: {
        action: "restart",
        targetGoalId: "goal_profile_skill",
        reason: "User asked to restart the selected goal.",
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
    expect(completed?.output).toContain("Profile skill goals cannot be controlled with generic goal control yet");
    expect(harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )).toHaveLength(1);
    expect((harness.events.find(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )?.data as any)?.goal).toMatchObject(profileSkillGoal);
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

  test("omits workflow delegation tools for terminal one-shot turns", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        workspaceKind: undefined,
        workspaceId: null,
        localProjectId: null,
        cwd: "/tmp/openpond-bench-task",
      },
      finalText: "One-shot task complete.",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "write the task output file",
      metadata: { openpondTerminalMode: "one-shot" },
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const toolNames = harness.streamInputs[0].tools.map((tool: any) => tool.function.name);
    expect(toolNames).not.toContain("openpond_create_pipeline");
    expect(toolNames).not.toContain("openpond_goal_control");
    expect(toolNames).not.toContain("openpond_profile_skill_goal");
    expect(toolNames).toEqual(expect.arrayContaining(["resource_search", "resource_read"]));
  });

  test("records local BYOK provider usage frames in the model usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        appId: "app_usage",
        appName: "Usage App",
        workspaceKind: "local_project",
        workspaceId: "workspace_usage",
        workspaceName: "Usage Workspace",
        localProjectId: "project_usage",
        cloudProjectId: "cloud_project_usage",
      },
      finalText: "Done.",
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer directly",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    const usage = harness.usageRecords[0]!;
    expect(usage).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "completed",
      requestOrdinal: 0,
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: turn.id,
        appId: "app_usage",
        workspaceKind: "local_project",
        workspaceId: "workspace_usage",
        localProjectId: "project_usage",
        cloudProjectId: "cloud_project_usage",
      },
    });
    expect(usage.firstTokenMs).not.toBeNull();
    expect("rawUsage" in usage).toBe(false);
  });

  test("records OpenPond hosted provider usage frames in the model usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      providerId: "openpond",
      modelId: "openpond-chat",
      toolArgs: null,
      finalText: "Hosted answer.",
      usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer through hosted",
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openpond",
      model: "openpond-chat",
      route: "openpond_hosted",
      source: "provider_usage",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "completed",
      requestOrdinal: 0,
      promptTokens: 21,
      completionTokens: 7,
      totalTokens: 28,
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: turn.id,
      },
    });
  });

  test("records hosted auto context compaction usage in the model usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      providerId: "openpond",
      modelId: "openpond-1k",
      toolArgs: null,
      initialEvents: hostedCompactionPriorEvents(),
      finalText: "Hosted answer after compaction.",
      usageByPass: {
        1: { prompt_tokens: 90, completion_tokens: 14, total_tokens: 104 },
        2: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer after compaction",
      modelRef: { providerId: "openpond", modelId: "openpond-1k" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(true);
    expect(harness.events.some((event) => event.name === "session.compaction.completed")).toBe(true);
    expect(harness.usageRecords).toHaveLength(2);

    const compactionUsage = harness.usageRecords.find((record) => record.requestKind === "context_compaction");
    expect(compactionUsage).toMatchObject({
      requestId: `${turn.id}:context-compaction:0`,
      requestOrdinal: 0,
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openpond",
      model: "openpond-1k",
      route: "openpond_hosted",
      source: "provider_usage",
      requestKind: "context_compaction",
      visibility: "background",
      status: "completed",
      promptTokens: 90,
      completionTokens: 14,
      totalTokens: 104,
      attribution: {
        surface: "compaction",
        workflowKind: "summary",
        sessionId: "session_1",
        turnId: turn.id,
      },
    });
    expect(compactionUsage?.firstTokenMs).not.toBeNull();

    const chatUsage = harness.usageRecords.find((record) => record.requestKind === "chat_turn");
    expect(chatUsage).toMatchObject({
      requestId: `${turn.id}:model:0`,
      source: "provider_usage",
      visibility: "user_facing",
      totalTokens: 24,
    });
  });

  test("blocks hosted sends over the context limit when auto compaction is disabled", async () => {
    const harness = createNativeGoalControlHarness({
      providerId: "openpond",
      modelId: "openpond-1k",
      toolArgs: null,
      initialEvents: [
        ...hostedCompactionPriorEvents(),
        {
          id: "prior_large_assistant",
          sessionId: "session_1",
          turnId: "prior_large_turn",
          name: "assistant.delta",
          timestamp: "2026-07-03T09:20:00.000Z",
          source: "provider",
          output: "x".repeat(6000),
        },
      ],
      finalText: "Hosted answer without compaction.",
      usageByPass: {
        1: { prompt_tokens: 180, completion_tokens: 8, total_tokens: 188 },
      },
      preferences: AppPreferencesSchema.parse({
        contextCompaction: {
          autoEnabled: false,
        },
      }),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer without compaction",
      modelRef: { providerId: "openpond", modelId: "openpond-1k" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("Start a new chat or turn auto compaction on");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(false);
    expect(harness.events.some((event) => event.name === "session.compaction.completed")).toBe(false);
    expect(harness.usageRecords).toHaveLength(0);
    expect(harness.streamInputs).toHaveLength(0);
  });

  test("auto compacts local BYOK context with the selected provider and model", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      initialEvents: hostedCompactionPriorEvents(),
      finalText: "BYOK answer after compaction.",
      usageByPass: {
        1: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
        2: { prompt_tokens: 22, completion_tokens: 5, total_tokens: 27 },
      },
      providerSettings: openRouterProviderSettingsWithContextWindow(2000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer after BYOK compaction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.streamInputs).toHaveLength(2);
    expect(harness.streamInputs[0]).toMatchObject({
      providerId: "openrouter",
      modelId: "test/model",
      requestId: expect.stringMatching(/^compact-/),
    });
    expect(harness.streamInputs[0].tools).toBeUndefined();
    expect(harness.streamInputs[1]).toMatchObject({
      providerId: "openrouter",
      modelId: "test/model",
    });
    expect(harness.streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Conversation summary from earlier turns"),
      }),
    );
    expect(JSON.stringify(harness.streamInputs[1].messages)).not.toContain(
      "We need to preserve the durable support workflow requirements.",
    );
    const completed = harness.events.find((event) => event.name === "session.compaction.completed");
    expect(completed?.data).toMatchObject({
      provider: "openrouter",
      model: "test/model",
      mode: "summary",
      maxContextTokens: 2000,
      summary: "BYOK answer after compaction.",
    });
    expect(harness.usageRecords.map((record) => record.requestKind)).toEqual([
      "context_compaction",
      "chat_turn",
    ]);
    expect(harness.usageRecords[0]).toMatchObject({
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      requestKind: "context_compaction",
      visibility: "background",
      totalTokens: 90,
    });
  });

  test("preserves BYOK context and continues when summary compaction fails below the hard ceiling", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      initialEvents: hostedCompactionPriorEvents(),
      finalText: "BYOK answer after failed compaction.",
      failOnPass: 1,
      usageByPass: {
        2: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
      },
      providerSettings: openRouterProviderSettingsWithContextWindow(2000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer after failed BYOK compaction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(true);
    const failed = harness.events.find((event) => event.name === "session.compaction.failed");
    expect(failed).toMatchObject({
      status: "failed",
      error: "stream failed on pass 1",
    });
    expect(harness.streamInputs).toHaveLength(2);
    expect(harness.streamInputs[1].messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "answer after failed BYOK compaction",
      }),
    );
    expect(harness.usageRecords.map((record) => [record.requestKind, record.status])).toEqual([
      ["context_compaction", "failed"],
      ["chat_turn", "completed"],
    ]);
  });

  test("blocks local BYOK sends over a trusted context limit when auto compaction is disabled", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      initialEvents: [
        ...hostedCompactionPriorEvents(),
        {
          id: "prior_large_byok_assistant",
          sessionId: "session_1",
          turnId: "prior_large_byok_turn",
          name: "assistant.delta",
          timestamp: "2026-07-03T09:20:00.000Z",
          source: "provider",
          output: "x".repeat(6000),
        },
      ],
      preferences: AppPreferencesSchema.parse({
        contextCompaction: {
          autoEnabled: false,
        },
      }),
      providerSettings: openRouterProviderSettingsWithContextWindow(1000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer without BYOK compaction",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("Start a new chat or turn auto compaction on");
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(false);
    expect(harness.streamInputs).toHaveLength(0);
    expect(harness.usageRecords).toHaveLength(0);
  });

  test("records local BYOK context usage when provider metadata includes a context window", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      finalText: "BYOK context measured.",
      usage: { prompt_tokens: 1200, completion_tokens: 50, total_tokens: 1250 },
      providerSettings: openRouterProviderSettingsWithContextWindow(10000),
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "measure local BYOK context",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const contextEvents = harness.events.filter((event) => event.name === "session.context.updated");
    expect(contextEvents).toHaveLength(2);
    expect(contextEvents.at(-1)?.data).toMatchObject({
      provider: "openrouter",
      model: "test/model",
      usedTokens: 1250,
      maxContextTokens: 10000,
      usableContextTokens: 2000,
      percentFull: 13,
      source: "provider_usage",
    });
    expect(harness.events.some((event) => event.name === "session.compaction.started")).toBe(false);
  });

  test("records Insights scan usage with system session attribution", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        title: "Insights system session",
        systemKind: "openpond.insights",
        hiddenFromDefaultSidebar: true,
        workspaceKind: "local_project",
        workspaceId: "project_usage",
        localProjectId: "project_usage",
      },
      finalText: "Usage insight found.",
      usage: { prompt_tokens: 55, completion_tokens: 9, total_tokens: 64 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "scan usage evidence",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      metadata: {
        insightsRun: {
          id: "insights_run_usage",
          trigger: "manual",
          sourceEventSequence: 123,
        },
        threadGoal: {
          id: "goal_insights_usage",
          provider: "openpond.insights",
          objective: "Find notable usage behavior.",
        },
      },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "insights_scan",
      visibility: "system",
      status: "completed",
      promptTokens: 55,
      completionTokens: 9,
      totalTokens: 64,
      attribution: {
        surface: "insights",
        workflowKind: "scan",
        sessionId: "session_1",
        turnId: turn.id,
        insightRunId: "insights_run_usage",
        goalId: "goal_insights_usage",
        localProjectId: "project_usage",
        workspaceKind: "local_project",
        workspaceId: "project_usage",
        sourceEventSequence: 123,
      },
    });
  });

  test("records Insights question usage with distinct system attribution", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        title: "Insights question session",
        systemKind: "openpond.insights",
        hiddenFromDefaultSidebar: true,
      },
      finalText: "The spike came from one model.",
      usage: { input_tokens: 24, output_tokens: 6 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "answer the usage question",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      metadata: {
        insightsQuestion: {
          question: "Why did usage spike?",
          runCount: 2,
          insightCount: 1,
          startedAt: "2026-07-04T12:00:00.000Z",
        },
        threadGoal: {
          id: "goal_insights_question",
          provider: "openpond.insights",
          objective: "Answer an Insights question.",
        },
      },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      requestKind: "insights_question",
      visibility: "system",
      source: "provider_usage",
      promptTokens: 24,
      completionTokens: 6,
      totalTokens: 30,
      attribution: {
        surface: "insights",
        workflowKind: "scan",
        sessionId: "session_1",
        turnId: turn.id,
        insightRunId: null,
        goalId: "goal_insights_question",
      },
    });
  });

  test("records goal-control usage with thread-goal attribution", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      sessionOverrides: {
        workspaceKind: "local_project",
        workspaceId: "project_usage",
        localProjectId: "project_usage",
      },
      finalText: "Goal status updated.",
      usage: { prompt_tokens: 44, completion_tokens: 11, total_tokens: 55 },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "continue the usage tracking goal",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      metadata: {
        threadGoal: {
          id: "goal_usage_tracking",
          provider: "openpond",
          objective: "Implement usage tracking.",
          status: "active",
        },
      },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "goal_control",
      visibility: "background",
      status: "completed",
      promptTokens: 44,
      completionTokens: 11,
      totalTokens: 55,
      attribution: {
        surface: "goal",
        workflowKind: "goal_control",
        sessionId: "session_1",
        turnId: turn.id,
        goalId: "goal_usage_tracking",
        localProjectId: "project_usage",
        workspaceKind: "local_project",
        workspaceId: "project_usage",
      },
    });
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )).toBe(true);
  });

  test("records tool-loop follow-up requests with stable request ordinals", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: {
        action: "start",
        objective: "Track model usage carefully.",
        reason: "User asked to start a goal.",
      },
      finalText: "Goal started.",
      usageByPass: {
        1: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
        2: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      },
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "start a goal to track usage",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    expect(harness.usageRecords.map((record) => record.requestId)).toEqual([
      `${turn.id}:model:0`,
      `${turn.id}:model:1`,
    ]);
    expect(harness.usageRecords.map((record) => record.requestOrdinal)).toEqual([0, 1]);
    expect(harness.usageRecords.map((record) => record.requestKind)).toEqual(["chat_turn", "tool_loop"]);
    expect(harness.usageRecords.map((record) => record.totalTokens)).toEqual([32, 45]);
    expect(harness.usageRecords[0]?.attribution.workflowKind).toBe("direct_chat");
    expect(harness.usageRecords[1]?.attribution.workflowKind).toBe("tool_loop");
    expect(harness.events.some((event) => event.name === "tool.completed" && event.action === "openpond_goal_control")).toBe(true);
  });

  test("records failed provider requests in the usage ledger", async () => {
    const harness = createNativeGoalControlHarness({
      toolArgs: null,
      failOnPass: 1,
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "this stream will fail",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("stream failed on pass 1");
    expect(harness.usageRecords).toHaveLength(1);
    expect(harness.usageRecords[0]).toMatchObject({
      sessionId: "session_1",
      turnId: turn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "missing",
      requestKind: "chat_turn",
      status: "failed",
      requestOrdinal: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: "Error",
      errorMessage: "stream failed on pass 1",
    });
    expect(harness.usageRecords[0]?.durationMs).not.toBeNull();
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
    const usageRecords: ModelUsageRecord[] = [];
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
        async upsertModelUsageRecord(record) {
          const index = usageRecords.findIndex((candidate) => candidate.requestId === record.requestId);
          if (index === -1) usageRecords.push(record);
          else usageRecords[index] = record;
          return record;
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
        if (turn?.prompt === "second") {
          yield {
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            raw: { ok: true, usage: true },
          };
        }
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
    expect(usageRecords).toHaveLength(2);

    const interruptedUsage = usageRecords.find((record) => record.turnId === firstTurn.id);
    expect(interruptedUsage).toMatchObject({
      requestId: `${firstTurn.id}:model:0`,
      sessionId: "session_1",
      turnId: firstTurn.id,
      provider: "openrouter",
      model: "test/model",
      route: "local_byok",
      source: "missing",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "interrupted",
      requestOrdinal: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: "AbortError",
      errorMessage: "Stopped by user",
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: firstTurn.id,
      },
    });
    expect(interruptedUsage?.durationMs).not.toBeNull();

    const completedUsage = usageRecords.find((record) => record.turnId === secondTurn.id);
    expect(completedUsage).toMatchObject({
      requestId: `${secondTurn.id}:model:0`,
      status: "completed",
      source: "provider_usage",
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
  });
});

function createNativeProfileSkillGoalHarness(input: {
  repoPath: string;
  profileSourcePath: string;
  toolArgs: Record<string, unknown>;
  finalText?: string;
  sessionOverrides?: Partial<Session>;
  usageByPass?: Record<number, unknown>;
}) {
  const sessions = new Map<string, Session>([
    ["session_1", baseSession({ title: "Profile skill native tool", ...(input.sessionOverrides ?? {}) })],
  ]);
  const turns: Turn[] = [];
  const events: RuntimeEvent[] = [];
  const approvals: Approval[] = [];
  const streamInputs: any[] = [];
  const usageRecords: ModelUsageRecord[] = [];
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
      async upsertModelUsageRecord(record) {
        const index = usageRecords.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) usageRecords.push(record);
        else usageRecords[index] = record;
        return record;
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
        const usage = usageForPass(streamPass);
        if (usage) yield { usage, raw: { pass: 1, usage: true } };
        yield { finishReason: "tool_calls", raw: { pass: 1 } };
        return;
      }
      yield { text: input.finalText ?? "Profile skill route handled.", raw: { pass: 2 } };
      const usage = usageForPass(streamPass);
      if (usage) yield { usage, raw: { pass: 2, usage: true } };
    },
    turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-follow-up-profile-skill-native" }),
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 2,
  });
  function usageForPass(pass: number): unknown {
    return input.usageByPass && Object.prototype.hasOwnProperty.call(input.usageByPass, pass)
      ? input.usageByPass[pass]
      : undefined;
  }
  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    streamInputs,
    usageRecords,
  };
}

function createNativeGoalControlHarness(input: {
  providerId?: "openpond" | "openrouter";
  modelId?: string;
  toolArgs?: Record<string, unknown> | null;
  initialEvents?: RuntimeEvent[];
  sessionOverrides?: Partial<Session>;
  finalText?: string;
  usage?: unknown;
  usageByPass?: Record<number, unknown>;
  failOnPass?: number;
  preferences?: AppPreferences;
  providerSettings?: ProviderSettings;
  enableGoalContinuations?: boolean;
}) {
  const providerId = input.providerId ?? "openrouter";
  const modelId = input.modelId ?? (providerId === "openpond" ? "openpond-chat" : "test/model");
  const sessions = new Map<string, Session>([
    [
      "session_1",
      baseSession({
        title: "Goal control native tool",
        provider: providerId,
        modelRef: { providerId, modelId },
        ...input.sessionOverrides,
      }),
    ],
  ]);
  const turns: Turn[] = [];
  const events: RuntimeEvent[] = [...(input.initialEvents ?? [])];
  const approvals: Approval[] = [];
  const streamInputs: any[] = [];
  const usageRecords: ModelUsageRecord[] = [];
  const turnFollowUpQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up-goal-control-native" });
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
      async upsertModelUsageRecord(record) {
        const index = usageRecords.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) usageRecords.push(record);
        else usageRecords[index] = record;
        return record;
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
    loadAppPreferences: async () => input.preferences ?? AppPreferencesSchema.parse({}),
    loadProviderSettings: input.providerSettings ? async () => input.providerSettings! : undefined,
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
    appendHostedContextUsage: async (contextInput) => {
      const usageEvent: RuntimeEvent = {
        id: `context_${events.length}`,
        sessionId: contextInput.session.id,
        turnId: contextInput.turnId,
        name: "session.context.updated",
        timestamp: "2026-07-03T10:00:00.000Z",
        source: "server",
        data: createContextUsageSnapshot({
          provider: contextInput.provider,
          model: contextInput.model,
          messages: contextInput.messages,
          maxContextTokens: contextInput.maxContextTokens,
          usage: contextInput.usage,
          includeCompletion: contextInput.includeCompletion,
          updatedAtEventId: null,
        }),
      };
      events.push(usageEvent);
    },
    streamOpenPondHostedChatTurn: async function* (streamInput) {
      streamInputs.push({
        providerId: "openpond",
        modelId: streamInput.model,
        messages: streamInput.messages,
        tools: streamInput.tools,
        toolChoice: streamInput.toolChoice,
      });
      for await (const delta of harnessStreamDeltas()) {
        if (delta.text) yield { type: "text_delta", text: delta.text, raw: delta.raw };
        if (delta.reasoningText) yield { type: "reasoning_delta", text: delta.reasoningText, raw: delta.raw };
        if (delta.toolCalls) yield { type: "tool_call_delta", toolCalls: delta.toolCalls, raw: delta.raw };
        if (delta.usage) yield { type: "usage", usage: delta.usage, raw: delta.raw };
        if (delta.finishReason !== undefined) yield { type: "finish", finishReason: delta.finishReason, raw: delta.raw };
      }
    },
    streamLocalByokChatTurn: async function* (streamInput) {
      if (providerId === "openpond") throw new Error("BYOK stream should not be used for OpenPond hosted tests");
      streamInputs.push(streamInput);
      yield* harnessStreamDeltas();
    },
    turnFollowUpQueue,
    enableGoalContinuations: input.enableGoalContinuations ?? false,
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 2,
  });

  async function* harnessStreamDeltas() {
    streamPass += 1;
    const pass = streamPass;
    if (input.failOnPass === pass) throw new Error(`stream failed on pass ${pass}`);
    if (pass === 1 && input.toolArgs) {
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
        raw: { pass },
      };
      const usage = usageForPass(pass);
      if (usage) yield { usage, raw: { pass, usage: true } };
      yield { finishReason: "tool_calls", raw: { pass } };
      return;
    }
    yield { text: input.finalText ?? "Goal control handled.", raw: { pass } };
    const usage = usageForPass(pass);
    if (usage) yield { usage, raw: { pass, usage: true } };
  }

  function usageForPass(pass: number): unknown {
    if (input.usageByPass && Object.prototype.hasOwnProperty.call(input.usageByPass, pass)) {
      return input.usageByPass[pass];
    }
    const fallbackPass = input.toolArgs ? 2 : 1;
    return pass === fallbackPass ? input.usage : undefined;
  }

  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    streamInputs,
    usageRecords,
    turnFollowUpQueue,
  };
}

function openRouterProviderSettingsWithContextWindow(contextWindow: number): ProviderSettings {
  return ProviderSettingsSchema.parse({
    providers: {
      openrouter: {
        enabled: true,
        baseUrl: "https://openrouter.ai/api/v1",
        defaultModel: "test/model",
      },
    },
    modelCaches: {
      openrouter: {
        providerId: "openrouter",
        source: "provider",
        fetchedAt: "2026-07-03T10:00:00.000Z",
        lastError: null,
        models: [
          {
            id: "test/model",
            providerId: "openrouter",
            displayName: "Test Model",
            contextWindow,
            outputLimit: null,
            source: "provider",
          },
        ],
      },
    },
  });
}

function hostedCompactionPriorEvents(): RuntimeEvent[] {
  return [
    {
      id: "prior_turn_1_started",
      sessionId: "session_1",
      turnId: "prior_turn_1",
      name: "turn.started",
      timestamp: "2026-07-03T09:00:00.000Z",
      source: "server",
      args: { prompt: "We need to preserve the durable support workflow requirements." },
    },
    {
      id: "prior_turn_1_assistant",
      sessionId: "session_1",
      turnId: "prior_turn_1",
      name: "assistant.delta",
      timestamp: "2026-07-03T09:00:01.000Z",
      source: "provider",
      output: "Support workflow requirements were captured with local-only constraints.",
    },
    {
      id: "prior_turn_2_started",
      sessionId: "session_1",
      turnId: "prior_turn_2",
      name: "turn.started",
      timestamp: "2026-07-03T09:05:00.000Z",
      source: "server",
      args: { prompt: "Keep the recent implementation notes available." },
    },
    {
      id: "prior_turn_2_assistant",
      sessionId: "session_1",
      turnId: "prior_turn_2",
      name: "assistant.delta",
      timestamp: "2026-07-03T09:05:01.000Z",
      source: "provider",
      output: "Recent notes remain available after compaction.",
    },
    {
      id: "prior_turn_3_started",
      sessionId: "session_1",
      turnId: "prior_turn_3",
      name: "turn.started",
      timestamp: "2026-07-03T09:10:00.000Z",
      source: "server",
      args: { prompt: "Continue from the current state." },
    },
    {
      id: "prior_turn_3_assistant",
      sessionId: "session_1",
      turnId: "prior_turn_3",
      name: "assistant.delta",
      timestamp: "2026-07-03T09:10:01.000Z",
      source: "provider",
      output: "Ready to continue from the current state.",
    },
  ];
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
