import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../apps/server/src/runtime/turn-runner";
import { withTurnRunnerTestStore } from "./helpers/turn-runner-test-harness";
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
import {
  baseSession,
  createNativeGoalControlHarness,
  createNativeProfileSkillGoalHarness,
} from "./helpers/byok-turn-runner-harness";

describe("BYOK turn runner profile, tools, and goal dispatch", () => {
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
        store: withTurnRunnerTestStore({
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
        }),
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
      store: withTurnRunnerTestStore({
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
      }),
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
      store: withTurnRunnerTestStore({
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
      }),
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
      store: withTurnRunnerTestStore({
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
      }),
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
      "openpond_create_improve",
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
        expect.arrayContaining(["openpond_create_improve", "openpond_profile_skill_goal"]),
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
        status: "running",
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
      status: "running",
      objective: "Ship the goal-control tool.",
      mode: "local",
    });
    const control = harness.events.find(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "goal_control",
    );
    expect(control?.output).toBe("OpenPond goal restarted.");
    expect((control?.data as any)?.goal).toMatchObject({
      id: "goal_1",
      status: "running",
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
      status: "running",
      objective: "Ship the goal-control tool.",
      controlAction: "restart",
    });
  });

  test("pauses an active goal from the composer even when no parent turn is running", async () => {
    const harness = createNativeGoalControlHarness({
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-goal-workspace",
      },
      initialEvents: [
        {
          id: "goal_running_event",
          sessionId: "session_1",
          turnId: "turn_prior",
          name: "diagnostic",
          timestamp: "2026-07-03T09:59:00.000Z",
          source: "provider",
          status: "completed",
          output: "Pause this goal safely.",
          data: {
            kind: "thread_goal",
            provider: "openpond",
            goal: {
              id: "goal_pause_from_composer",
              provider: "openpond",
              objective: "Pause this goal safely.",
              status: "running",
              mode: "local",
              reason: "Goal is active.",
              controlAction: "start",
              previousStatus: null,
              source: "model_tool",
              createdAt: "2026-07-03T09:59:00.000Z",
              updatedAt: "2026-07-03T09:59:00.000Z",
            },
          },
        },
      ],
    });

    const result = await harness.runner.pauseSessionGoal("session_1");

    expect(result).toMatchObject({
      goalId: "goal_pause_from_composer",
      action: "pause",
      status: "paused",
    });
    const latestGoal = harness.events.filter(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    ).at(-1);
    expect((latestGoal?.data as any)?.goal).toMatchObject({
      id: "goal_pause_from_composer",
      status: "paused",
      controlAction: "pause",
      previousStatus: "running",
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
        expect.arrayContaining(["openpond_create_improve", "openpond_goal_control"]),
      );
    }
    expect(harness.events.some((event) => event.name === "create_improve.updated")).toBe(false);
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

});
