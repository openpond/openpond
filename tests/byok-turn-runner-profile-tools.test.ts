import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";
import {
  loadBundledAuthoringSkills,
  readBundledAuthoringProfileSkill,
} from "../apps/server/src/runtime/bundled-authoring-skills";
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
import { runProfileSkillCommand } from "../packages/cloud/src/profile/profile-skill-mutations";
import { loadProfileSkills, readProfileSkill } from "../packages/cloud/src/profile/profile-skills";
import {
  baseSession,
  createByokTurnRunnerHarness,
} from "./helpers/byok-turn-runner-harness";

describe("BYOK turn runner profile and tools", () => {
  test("routes profile skill creation through a normal skill-backed turn and loads an existing skill from another chat", async () => {
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

      const selectedProfileRef = {
        source: "local" as const,
        repositoryId: "profile-repo",
        profileId: "default",
      };
      const sessions = new Map<string, Session>([
        ["session_create", baseSession({
          id: "session_create",
          title: "Create skill",
          currentProfile: selectedProfileRef,
        })],
        ["session_use", baseSession({
          id: "session_use",
          title: "Use skill",
          currentProfile: selectedProfileRef,
        })],
      ]);
      const turns: Turn[] = [];
      const events: RuntimeEvent[] = [];
      const approvals: Approval[] = [];
      const capturedSystemOptions = new Map<string, any>();
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
        loadOpenPondProfileStateForRef: loadTempProfileState,
        readOpenPondProfileSkill: readProfileSkill,
        loadBuiltInOpenPondSkills: loadBundledAuthoringSkills,
        readBuiltInOpenPondSkill: readBundledAuthoringProfileSkill,
        loadPersonalizationSoul: async () => "",
        maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
        hostedSystemPrompt: async (_base, _soul, activeSession, options) => {
          capturedSystemOptions.set(activeSession.id, options);
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
          const skillName = capturedSystemOptions.get(
            input.messages.some((message: any) => message.content?.includes("/skill create"))
              ? "session_create"
              : "session_use",
          )?.loadedProfileSkills?.[0]?.name ?? "missing-skill";
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
      expect(capturedCreateMessages.length).toBeGreaterThan(0);
      expect(createTurn.createImproveRun).toBeNull();
      expect(createTurn.metadata.authoringIntent).toMatchObject({
        artifact: "skill",
        operation: "create",
        targetSkillName: "support-handoff-summaries",
      });
      expect(capturedSystemOptions.get("session_create")?.loadedProfileSkills?.[0]?.name)
        .toBe("openpond-skill-authoring");
      expect(events.some((event) =>
        event.sessionId === "session_create" &&
        event.name === "skill.loaded" &&
        (event.data as any)?.skillName === "openpond-skill-authoring"
      )).toBe(true);
      expect(events.some((event) =>
        event.sessionId === "session_create" &&
        event.name === "diagnostic" &&
        (event.data as any)?.kind === "thread_goal"
      )).toBe(false);
      expect(events.some((event) =>
        event.sessionId === "session_create" &&
        event.name === "create_improve.updated"
      )).toBe(false);

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
      const skillPackagePath = path.dirname(skillPath);
      await mkdir(path.join(skillPackagePath, "scripts"), { recursive: true });
      await writeFile(
        path.join(skillPackagePath, "scripts", "render.py"),
        "print('render')\n",
        "utf8",
      );

      const useTurn = await runner.sendTurn("session_use", {
        prompt: "Use $support-handoff-summaries for this customer escalation.",
        modelRef: { providerId: "openrouter", modelId: "test/model" },
      });
      expect(useTurn.status).toBe("completed");
      expect(capturedSystemOptions.get("session_use")?.openPondProfileSkills?.some(
        (skill: any) => skill.name === "support-handoff-summaries",
      )).toBe(true);
      expect(capturedSystemOptions.get("session_use")?.loadedProfileSkills?.[0]).toMatchObject({
        name: "support-handoff-summaries",
        body: expect.stringContaining("support handoff summaries"),
        packagePath: skillPackagePath,
        resourceFiles: ["scripts/render.py"],
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
    expect(
      events
        .filter((event) => event.name === "assistant.delta")
        .map((event) => event.output ?? "")
        .join(""),
    ).toBe("BYOK hello");
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
      "ask_user",
      "openpond_action_run",
      "openpond_action_search",
      "resource_read",
      "resource_search",
      "web_fetch",
      "web_search",
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

  test("does not hard-route conceptual create or skill questions into workflow tools", async () => {
    const harness = createByokTurnRunnerHarness({
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
        expect.arrayContaining(["ask_user"]),
      );
    }
    expect(harness.events.some((event) => event.name === "create_improve.updated")).toBe(false);
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "profile_skill_command",
    )).toBe(false);
    expect(harness.events.some(
      (event) => event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal",
    )).toBe(false);
  });

});
