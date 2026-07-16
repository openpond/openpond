import path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  emptyOpenPondProfileState,
  ProviderSettingsSchema,
  type BootstrapPayload,
  type ProviderSettings,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  createLineModeTurnGuard,
  createTerminalTurnSubmissionGuard,
  LINE_MODE_TURN_RUNNING_MESSAGE,
  TERMINAL_TURN_RUNNING_MESSAGE,
} from "../apps/terminal/src/line-mode-turn-guard";

import { parseTerminalArgs, resolveTerminalChatMode, shouldRunOneShotChat, TerminalUsageError } from "../apps/terminal/src/args";
import {
  handleTerminalSlashCommand,
  resolveTerminalCommandApproval,
  type TerminalCommandContext,
} from "../apps/terminal/src/command-handlers";
import {
  formatTerminalCommandApprovalQuestion,
  latestPendingCommandApproval,
  parseTerminalPermissionChoice,
  terminalPermissionDecision,
} from "../apps/terminal/src/permissions";
import {
  openTerminalEvents,
  readTerminalEventStream,
  terminalEventReconnectDelayMs,
  terminalEventStreamRequest,
  type TerminalEventStreamStatus,
  validateTerminalEventResponse,
} from "../apps/terminal/src/events";
import { apiFetch } from "../apps/terminal/src/connection";
import {
  runTerminalDirectCommand,
  terminalDirectCommandBlockedReason,
} from "../apps/terminal/src/direct-command";
import { createOneShotAccumulator, runOneShotChat, TerminalOneShotExitError } from "../apps/terminal/src/one-shot-chat";
import {
  activeModelId,
  blockingSetupRequirementsForAction,
  formatModelOptions,
  formatProfileAgents,
  formatProfileCatalog,
  formatProviderOptions,
  modelLabel,
  parseProviderModelSelection,
  resolveModelSelection,
} from "../apps/terminal/src/formatting";
import {
  formatTerminalProjects,
  resolveTerminalProjectTarget,
} from "../apps/terminal/src/projects";
import {
  createTerminalChatSession,
  ensureTerminalSessionWorkspaceReady,
  ensureTerminalChatSession,
  profileLabel,
  resolveResumedTerminalSelection,
} from "../apps/terminal/src/session-state";
import {
  createLatestWinsTaskScheduler,
  createSerialTaskScheduler,
} from "../apps/terminal/src/task-scheduler";
import { createTerminalRenderScheduler as createTerminalUiRenderScheduler } from "../apps/terminal/src/ui/render-scheduler";
import {
  appendRuntimeEvent,
  appendTranscriptItem,
  commitReadyTranscriptItems,
  limitActiveTranscriptItems,
  MAX_ACTIVE_STREAMING_TEXT_BYTES,
  type TranscriptItem,
} from "../apps/terminal/src/ui/transcript";
import {
  parseDirectCommandPrompt,
  parseSlashCommand,
} from "../apps/terminal/src/ui/commands";
import { runProcessCommand } from "../apps/cli/src/process-runner";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function eventStreamResponse(frames: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function runtimeEvent(input: Partial<RuntimeEvent> & Pick<RuntimeEvent, "id" | "name">): RuntimeEvent {
  return {
    timestamp: "2026-07-01T00:00:00.000Z",
    ...input,
  } as RuntimeEvent;
}

function estimatedTranscriptBytes(items: TranscriptItem[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength;
}

function terminalBootstrapFixture() {
  return {
    localProjects: [
      {
        id: "local_project_1",
        name: "Local Website",
        path: "/repo/site",
        workspacePath: "/repo/site",
        repoPath: "/repo/site",
        source: "git",
        linkedOpenPondApp: { appId: "app_linked", appName: "Linked App" },
        linkedSandboxProject: { projectId: "cloud_linked", teamId: "team_1" },
      },
    ],
    cloudProjects: [
      {
        id: "cloud_project_1",
        teamId: "team_2",
        name: "Cloud Worker",
        slug: "cloud-worker",
      },
    ],
    apps: [
      {
        id: "app_1",
        name: "Hosted App",
      },
    ],
  } as unknown as import("@openpond/contracts").BootstrapPayload;
}

function terminalProviderSettingsFixture(): ProviderSettings {
  return ProviderSettingsSchema.parse({
    version: 1,
    providers: {
      openai: {
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1",
        modelOverrides: ["gpt-4.1-mini"],
      },
    },
    statuses: {
      openai: {
        id: "openai",
        displayName: "OpenAI",
        credentialModes: ["local-byok"],
        routing: {
          localRuntime: true,
          localByok: true,
        },
        available: false,
        enabled: true,
        defaultModel: "gpt-4.1",
        modelIds: ["gpt-4.1", "gpt-4.1-mini"],
      },
      openpond: {
        id: "openpond",
        displayName: "OpenPond",
        credentialModes: ["openpond-account"],
        routing: {
          hostedOpChat: true,
          localRuntime: false,
          localByok: false,
        },
        available: true,
        enabled: true,
      },
    },
    modelCaches: {
      openai: {
        providerId: "openai",
        source: "provider",
        models: [
          {
            id: "gpt-4.1",
            providerId: "openai",
            displayName: "GPT-4.1",
            contextWindow: 128_000,
            source: "provider",
            capabilities: {
              reasoning: true,
            },
          },
        ],
      },
    },
  });
}

function terminalProfileFixture(): BootstrapPayload["profile"] {
  const profile = emptyOpenPondProfileState();
  const blockingRequirement = {
    ref: "action:support-items.open-items:fixture-data",
    source: "action_catalog" as const,
    actionId: "support-items.open-items",
    kind: "fixture",
    label: "support fixtures",
    status: "setup_required",
    required: true,
    blocking: true,
  };
  return {
    ...profile,
    mode: "local",
    repoPath: "/repo",
    activeProfile: "default",
    sourcePath: "/repo/profiles/default/agents/support-items",
    agents: [
      {
        id: "support-items",
        name: "Support Items",
        path: "profiles/default/agents/support-items",
        enabled: true,
      },
    ],
    catalog: {
      ...profile.catalog,
      actionCount: 2,
      stale: false,
    },
    actionCatalog: [
      {
        id: "support-items.chat",
        name: "chat",
        label: "Support chat",
        description: "Answers committed support fixture questions",
      },
      {
        id: "support-items.open-items",
        name: "open-items",
        label: "Open items",
        description: "Lists blocked support customers",
      },
    ],
    setupGate: {
      status: "setup_required",
      requirementCount: 1,
      blockingCount: 1,
      optionalMissingCount: 0,
      readyCount: 0,
      requirements: [blockingRequirement],
      blockingRequirements: [blockingRequirement],
    },
    summary: {
      ...profile.summary,
      state: "ready",
      message: "Profile ready",
      agentCount: 1,
      actionCount: 2,
      defaultAction: "support-items.chat",
      checkFresh: true,
      checkStaleReason: null,
    },
  };
}

function terminalSessionBootstrapFixture(): BootstrapPayload {
  return {
    ...terminalBootstrapFixture(),
    providers: terminalProviderSettingsFixture(),
    profile: terminalProfileFixture(),
    sessions: [
      {
        id: "session-current",
        provider: "openpond",
        openPondCommandAccessMode: "ask",
      },
      {
        id: "session-openai",
        provider: "openpond",
        modelRef: {
          providerId: "openai",
          modelId: "gpt-4.1",
        },
      },
      {
        id: "session-provider-only",
        provider: "openrouter",
      },
    ],
    codexHistorySessions: [
      {
        id: "session-codex",
        provider: "codex",
      },
    ],
    approvals: [],
  } as unknown as BootstrapPayload;
}

function terminalCommandContextFixture(payload = terminalSessionBootstrapFixture()) {
  const items: TranscriptItem[] = [];
  const openedUrls: string[] = [];
  let renders = 0;
  let exited = false;
  let activeSessionId: string | null = "session-current";
  let activeAgentId: string | null = "support-items";
  let currentPayload: BootstrapPayload | null = payload;
  const context: TerminalCommandContext = {
    options: {
      server: "http://127.0.0.1:17874",
      provider: "openpond",
      model: "old-model",
      cwd: "/repo",
      project: null,
      resume: null,
      noServerStart: true,
    },
    getConnection: () => ({
      server: "http://127.0.0.1:17874",
      token: "local-token",
    }),
    getPayload: () => currentPayload,
    getActiveSessionId: () => activeSessionId,
    setActiveSessionId: (sessionId) => {
      activeSessionId = sessionId;
    },
    getActiveAgentId: () => activeAgentId,
    setActiveAgentId: (agentId) => {
      activeAgentId = agentId;
    },
    refreshBootstrap: async () => {
      currentPayload = payload;
      return payload;
    },
    addItem: (item) => {
      items.push(item);
    },
    clearTranscript: () => {
      items.length = 0;
    },
    requestExit: () => {
      exited = true;
    },
    render: () => {
      renders += 1;
    },
    openUrl: (url) => {
      openedUrls.push(url);
    },
  };
  return {
    context,
    items,
    openedUrls,
    get renders() {
      return renders;
    },
    get exited() {
      return exited;
    },
    get activeSessionId() {
      return activeSessionId;
    },
    get activeAgentId() {
      return activeAgentId;
    },
  };
}


describe("terminal formatting helpers", () => {
  test("parses provider/model shorthand and resolves provider defaults", () => {
    const settings = terminalProviderSettingsFixture();

    expect(parseProviderModelSelection("openai/gpt-4.1", "openpond")).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    expect(parseProviderModelSelection("default", "openai")).toEqual({
      provider: "openai",
      model: null,
    });
    expect(activeModelId({ provider: "openai", model: null }, settings)).toBe("gpt-4.1");
    expect(modelLabel(settings, { provider: "openai", model: null })).toBe("GPT-4.1");
  });

  test("formats provider and model choices from provider settings", () => {
    const settings = terminalProviderSettingsFixture();

    const providers = formatProviderOptions(settings, "openai");
    expect(providers).toContain("* openai");
    expect(providers).toContain("OpenAI - needs-key");
    expect(providers).toContain("openpond");
    expect(providers).toContain("OpenPond - ready");

    const models = formatModelOptions(settings, "openai", null);
    expect(models).toContain("* gpt-4.1");
    expect(models).toContain("GPT-4.1 - 128K context, reasoning, provider");

    expect(resolveModelSelection(settings, "openai", "mini")).toEqual({
      changed: true,
      model: "gpt-4.1-mini",
      message: "Model set to gpt-4.1-mini",
    });
  });

  test("formats profile catalog and agents with setup gates", () => {
    const profile = terminalProfileFixture();

    expect(blockingSetupRequirementsForAction(profile, "support-items.chat")).toEqual([]);
    expect(blockingSetupRequirementsForAction(profile, "support-items.open-items")).toHaveLength(1);

    const catalog = formatProfileCatalog(profile);
    expect(catalog).toContain("support-items.chat  Support chat - Answers committed support fixture questions");
    expect(catalog).toContain("support-items.open-items  Open items - Lists blocked support customers setup_required:support fixtures");

    const agents = formatProfileAgents(profile, "support-items");
    expect(agents).toContain("* support-items  enabled  profiles/default/agents/support-items");
    expect(agents).toContain("/run support-items.open-items  Open items  setup_required:support fixtures");
  });
});

describe("terminal session-state helpers", () => {
  test("resolves resumed session provider and model selection", () => {
    const payload = terminalSessionBootstrapFixture();

    expect(profileLabel(payload)).toBe("default");
    expect(
      resolveResumedTerminalSelection(payload, "session-openai", {
        provider: "openpond",
        model: null,
      })
    ).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
    expect(
      resolveResumedTerminalSelection(payload, "session-provider-only", {
        provider: "openpond",
        model: "manual-model",
      })
    ).toEqual({
      provider: "openrouter",
      model: "manual-model",
    });
    expect(
      resolveResumedTerminalSelection(payload, "missing-session", {
        provider: "openpond",
        model: null,
      })
    ).toEqual({
      provider: "openpond",
      model: null,
    });
  });

  test("keeps resumed sessions without creating a new session", async () => {
    const payload = terminalSessionBootstrapFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("resume should not create a session");
    }) as typeof fetch;
    try {
      await expect(
        ensureTerminalChatSession(
          { server: "http://127.0.0.1:17874", token: "local-token" },
          payload,
          {
            provider: "openpond",
            model: null,
            cwd: "/repo",
            project: null,
          },
          "session-openai"
        )
      ).resolves.toEqual({
        sessionId: "session-openai",
        session: payload.sessions.find((session) => session.id === "session-openai"),
        provider: "openai",
        model: "gpt-4.1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("creates terminal chat sessions with desktop-aligned project metadata", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "created-session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await expect(
        createTerminalChatSession(
          { server: "http://127.0.0.1:17874", token: "local-token" },
          terminalSessionBootstrapFixture(),
          {
            provider: "openai",
            model: null,
            cwd: "/repo",
            project: "local_project_1",
          }
        )
      ).resolves.toEqual({ id: "created-session" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/v1/sessions",
        body: {
          provider: "openai",
          modelRef: {
            providerId: "openai",
            modelId: "gpt-4.1",
          },
          title: "Local Website terminal",
          appId: "app_linked",
          appName: "Linked App",
          workspaceKind: "local_project",
          workspaceId: "local_project_1",
          workspaceName: "Local Website",
          localProjectId: "local_project_1",
          cloudProjectId: "cloud_linked",
          cloudTeamId: "team_1",
          cwd: "/repo/site",
        },
      },
    ]);
  });

  test("uses the shared server readiness operation for Cloud sessions", async () => {
    const session = terminalSessionBootstrapFixture().sessions[0]!;
    const cloudSession = {
      ...session,
      id: "session-cloud-ready",
      workspaceKind: "sandbox" as const,
      workspaceId: null,
    };
    const originalFetch = globalThis.fetch;
    let request: { path: string; body: unknown } | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      request = {
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      return new Response(JSON.stringify({
        session: { ...cloudSession, workspaceId: "sandbox-ready" },
        status: "started",
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await expect(ensureTerminalSessionWorkspaceReady(
        { server: "http://127.0.0.1:17874", token: "local-token" },
        cloudSession,
      )).resolves.toMatchObject({ workspaceId: "sandbox-ready" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(request).toEqual({
      path: "/v1/sessions/session-cloud-ready/workspace/ensure-ready",
      body: { surface: "terminal" },
    });
  });

  test("creates untargeted terminal chats as normal visible local chat requests", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "created-session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await expect(
        createTerminalChatSession(
          { server: "http://127.0.0.1:17874", token: "local-token" },
          terminalSessionBootstrapFixture(),
          {
            provider: "openai",
            model: null,
            cwd: "/repo",
            project: null,
          }
        )
      ).resolves.toEqual({ id: "created-session" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/v1/sessions",
        body: {
          provider: "openai",
          modelRef: {
            providerId: "openai",
            modelId: "gpt-4.1",
          },
          title: "Terminal chat",
          appId: null,
          appName: null,
          cwd: "/repo",
        },
      },
    ]);
  });
});

describe("terminal slash command handler", () => {
  test("parses permissions and direct command prompts", () => {
    expect(parseSlashCommand("/permissions full-access")).toEqual({
      type: "permissions",
      args: ["full-access"],
    });
    expect(parseDirectCommandPrompt("!docker system df")).toEqual({
      command: "docker system df",
    });
    expect(parseDirectCommandPrompt("!   ")).toBeNull();
  });

  test("switches provider and resets explicit model selection", async () => {
    const fixture = terminalCommandContextFixture();

    await handleTerminalSlashCommand(
      { type: "provider", id: "openai" },
      fixture.context
    );

    expect(fixture.context.options.provider).toBe("openai");
    expect(fixture.context.options.model).toBe(null);
    expect(fixture.renders).toBe(1);
    expect(fixture.items).toHaveLength(1);
    expect(fixture.items[0]).toMatchObject({
      kind: "system",
      tone: "info",
    });
    expect(fixture.items[0]?.kind === "system" ? fixture.items[0].text : "").toContain(
      "Provider set to OpenAI / GPT-4.1"
    );
  });

  test("blocks profile runs with unresolved required setup", async () => {
    const fixture = terminalCommandContextFixture();

    await handleTerminalSlashCommand(
      {
        type: "run",
        action: "support-items.open-items",
        input: undefined,
      },
      fixture.context
    );

    expect(fixture.items).toHaveLength(1);
    expect(fixture.items[0]).toMatchObject({
      kind: "system",
      tone: "warning",
    });
    const text = fixture.items[0]?.kind === "system" ? fixture.items[0].text : "";
    expect(text).toContain("agent_source_setup_required");
    expect(text).toContain("support fixtures");
  });

  test("project command starts a new session for the resolved target", async () => {
    const originalFetch = globalThis.fetch;
    const fixture = terminalCommandContextFixture();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "project-session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await handleTerminalSlashCommand(
        { type: "project", id: "local_project_1" },
        fixture.context
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fixture.context.options.project).toBe("local_project_1");
    expect(fixture.activeSessionId).toBe("project-session");
    expect(fixture.renders).toBe(1);
    expect(fixture.items[0]?.kind === "system" ? fixture.items[0].text : "").toContain(
      "Project set to local_project: Local Website"
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      provider: "openpond",
      title: "Local Website terminal",
      workspaceKind: "local_project",
      workspaceId: "local_project_1",
      cwd: "/repo/site",
    });
  });

  test("permissions command patches active session command access mode", async () => {
    const originalFetch = globalThis.fetch;
    const fixture = terminalCommandContextFixture();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "session-current", openPondCommandAccessMode: "full-access" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await handleTerminalSlashCommand(
        { type: "permissions", args: ["full-access"] },
        fixture.context,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/v1/sessions/session-current",
        body: { openPondCommandAccessMode: "full-access" },
      },
    ]);
    expect(fixture.items[0]?.kind === "system" ? fixture.items[0].text : "").toContain(
      "Command access set to Full access.",
    );
  });

  test("permissions command opens pending command approval question mode", async () => {
    let openedApprovalId: string | null = null;
    const payload = {
      ...terminalSessionBootstrapFixture(),
      approvals: [
        {
          id: "approval-command-1",
          sessionId: "session-current",
          turnId: "turn-1",
          providerRequestId: "request-1",
          kind: "command",
          title: "docker system df",
          detail: JSON.stringify({
            command: "docker system df",
            cwd: "/repo/site",
            risk: "read",
            timeoutSeconds: 120,
            sessionApprovalFamily: {
              label: "docker system",
            },
          }),
          status: "pending",
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      ],
    } as unknown as BootstrapPayload;
    const fixture = terminalCommandContextFixture(payload);
    fixture.context.openCommandApprovalQuestion = (approval) => {
      openedApprovalId = approval.id;
    };

    await handleTerminalSlashCommand(
      { type: "permissions", args: [] },
      fixture.context,
    );

    expect(openedApprovalId).toBe("approval-command-1");
    expect(latestPendingCommandApproval(payload, "session-current")?.id).toBe("approval-command-1");
    expect(formatTerminalCommandApprovalQuestion(payload.approvals[0]!)).toContain("session approval family: docker system");
  });

  test("terminal permission choices map to approval resolution decisions", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "approval-command-1", status: "accepted_for_session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      expect(parseTerminalPermissionChoice("session")).toBe("session");
      expect(terminalPermissionDecision("session")).toBe("acceptForSession");
      await resolveTerminalCommandApproval(
        { server: "http://127.0.0.1:17874", token: "local-token" },
        "approval-command-1",
        "session",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/v1/approvals/approval-command-1",
        body: { decision: "acceptForSession" },
      },
    ]);
  });

  test("terminal direct commands post to the dedicated command endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const session = {
      id: "session-current",
      provider: "openpond",
      workspaceKind: "local_project",
      cwd: "/repo/site",
    } as BootstrapPayload["sessions"][number];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ session, events: [], result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      expect(terminalDirectCommandBlockedReason(session)).toBeNull();
      await expect(
        runTerminalDirectCommand(
          { server: "http://127.0.0.1:17874", token: "local-token" },
          session,
          "docker system df",
        ),
      ).resolves.toMatchObject({ result: { ok: true } });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/v1/sessions/session-current/commands",
        body: {
          command: "docker system df",
          cwd: "/repo/site",
        },
      },
    ]);
  });

  test("terminal direct commands post sandbox sessions to the dedicated command endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const session = {
      id: "session-sandbox",
      provider: "openpond",
      workspaceKind: "sandbox",
      workspaceId: "sandbox-1",
      cwd: null,
    } as BootstrapPayload["sessions"][number];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ session, events: [], result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      expect(terminalDirectCommandBlockedReason(session)).toBeNull();
      await expect(
        runTerminalDirectCommand(
          { server: "http://127.0.0.1:17874", token: "local-token" },
          session,
          "pnpm typecheck",
        ),
      ).resolves.toMatchObject({ result: { ok: true } });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/v1/sessions/session-sandbox/commands",
        body: {
          command: "pnpm typecheck",
          cwd: null,
        },
      },
    ]);
  });

  test("terminal direct commands require a supported workspace session", () => {
    expect(terminalDirectCommandBlockedReason(null)).toBe("Select a project to use this.");
    expect(
      terminalDirectCommandBlockedReason({
        id: "session-codex",
        provider: "codex",
        workspaceKind: "local_project",
        cwd: "/repo/site",
      } as BootstrapPayload["sessions"][number]),
    ).toBe("Select a project to use this.");
    expect(
      terminalDirectCommandBlockedReason({
        id: "session-cloud",
        provider: "openpond",
        workspaceKind: "sandbox",
        workspaceId: "sandbox-1",
        cwd: null,
      } as BootstrapPayload["sessions"][number]),
    ).toBeNull();
    expect(
      terminalDirectCommandBlockedReason({
        id: "session-cloud-missing-workspace",
        provider: "openpond",
        workspaceKind: "sandbox",
        cwd: null,
      } as BootstrapPayload["sessions"][number]),
    ).toBe("Select a project to use this.");
  });
});

describe("terminal event stream helpers", () => {
  test("terminal api fetch sends bearer auth and surfaces server errors", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string | null; body: string | null }> = [];
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(url),
        authorization: headers.get("Authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (String(url).endsWith("/fail")) {
        return new Response(JSON.stringify({ error: "terminal API failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await expect(
        apiFetch("http://127.0.0.1:17874", "local-token", "/ok", {
          method: "POST",
          body: JSON.stringify({ prompt: "hello" }),
        })
      ).resolves.toEqual({ ok: true });
      await expect(
        apiFetch("http://127.0.0.1:17874", "local-token", "/fail")
      ).rejects.toThrow("terminal API failed");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17874/ok",
        authorization: "Bearer local-token",
        body: '{"prompt":"hello"}',
      },
      {
        url: "http://127.0.0.1:17874/fail",
        authorization: "Bearer local-token",
        body: null,
      },
    ]);
  });

  test("uses Authorization headers instead of query-string tokens", () => {
    const request = terminalEventStreamRequest("http://127.0.0.1:17874/", "local-token");
    const headers = request.init.headers as Headers;

    expect(request.url).toBe("http://127.0.0.1:17874/v1/events");
    expect(request.url).not.toContain("token=");
    expect(headers.get("Authorization")).toBe("Bearer local-token");
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  test("validates event stream response status and body", () => {
    expect(() => validateTerminalEventResponse(new Response(null, { status: 401 }))).toThrow(
      /event stream failed: 401/,
    );
    expect(() => validateTerminalEventResponse(new Response(null, { status: 200 }))).toThrow(
      /response body/,
    );
  });

  test("parses SSE frames for the active session and ignores unrelated sessions", async () => {
    const events: Array<{ name: string; sessionId?: string }> = [];
    await readTerminalEventStream(
      eventStreamResponse(
        [
          'event: ready\ndata: {"ok":true}',
          "",
          'data: {"name":"turn.started","sessionId":"active"}',
          "",
          'data: {"name":"turn.started","sessionId":"other"}',
          "",
          'data: {"name":"assistant.delta","output":"hello"}',
          "",
          "data: not-json",
          "",
          "",
        ].join("\n"),
      ),
      () => "active",
      (event) => events.push({ name: event.name, sessionId: event.sessionId }),
    );

    expect(events).toEqual([
      { name: "turn.started", sessionId: "active" },
      { name: "assistant.delta", sessionId: undefined },
    ]);
  });

  test("caps reconnect backoff", () => {
    expect(terminalEventReconnectDelayMs(0)).toBe(500);
    expect(terminalEventReconnectDelayMs(1)).toBe(1000);
    expect(terminalEventReconnectDelayMs(5)).toBe(10000);
    expect(terminalEventReconnectDelayMs(20)).toBe(10000);
  });

  test("reconnects after a failed event stream request and resumes event replay", async () => {
    const statuses: TerminalEventStreamStatus[] = [];
    const events: RuntimeEvent[] = [];
    let requestCount = 0;
    let resolveCompleted = (): void => undefined;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const handle = await openTerminalEvents({
      server: "http://127.0.0.1:17874",
      token: "local-token",
      activeSessionId: () => "active",
      reconnectDelayMs: () => 1,
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => {
        events.push(event);
        resolveCompleted();
      },
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) return new Response(null, { status: 503, statusText: "unavailable" });
        return eventStreamResponse('data: {"id":"event-after-reconnect","name":"turn.completed","sessionId":"active","timestamp":"2026-07-01T00:00:00.000Z"}\n\nevent: ready\ndata: {"ok":true}\n\n');
      },
    });
    await expect(handle.ready).resolves.toBeUndefined();
    await completed;
    handle.abort();

    expect(requestCount).toBe(2);
    expect(statuses.slice(0, 4).map((status) => status.state)).toEqual(["connecting", "disconnected", "connecting", "connected"]);
    expect(events.map((event) => event.id)).toEqual(["event-after-reconnect"]);
  });
});

describe("terminal render scheduler", () => {
  function fakeTimers() {
    let nextId = 1;
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    return {
      setTimer(callback: () => void, delayMs: number) {
        const id = nextId++;
        timers.set(id, { callback, delayMs });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer(timer: ReturnType<typeof setTimeout>) {
        timers.delete(timer as unknown as number);
      },
      pendingCount() {
        return timers.size;
      },
      delays() {
        return [...timers.values()].map((timer) => timer.delayMs);
      },
      runNext() {
        const entry = timers.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
        if (!entry) throw new Error("No timer is pending");
        timers.delete(entry[0]);
        entry[1].callback();
      },
    };
  }

  test("batches rapid event renders into one paint", () => {
    const timers = fakeTimers();
    let renders = 0;
    const scheduler = createTerminalUiRenderScheduler(() => {
      renders += 1;
    }, {
      maxFps: 60,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();

    expect(renders).toBe(0);
    expect(timers.pendingCount()).toBe(1);
    expect(timers.delays()).toEqual([17]);

    timers.runNext();

    expect(renders).toBe(1);
    expect(timers.pendingCount()).toBe(0);
  });

  test("flush paints pending work once and clears the frame timer", () => {
    const timers = fakeTimers();
    let renders = 0;
    const scheduler = createTerminalUiRenderScheduler(() => {
      renders += 1;
    }, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request();
    scheduler.request();
    scheduler.flush();

    expect(renders).toBe(1);
    expect(timers.pendingCount()).toBe(0);
  });

  test("cancel drops pending event renders", () => {
    const timers = fakeTimers();
    let renders = 0;
    const scheduler = createTerminalUiRenderScheduler(() => {
      renders += 1;
    }, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request();
    scheduler.cancel();

    expect(renders).toBe(0);
    expect(timers.pendingCount()).toBe(0);
  });

  test("replays high-frequency assistant deltas with a single scheduled paint", async () => {
    const timers = fakeTimers();
    let renders = 0;
    let transcript: TranscriptItem[] = [];
    const scheduler = createTerminalUiRenderScheduler(() => {
      renders += 1;
    }, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const frames = Array.from({ length: 100 }, (_, index) =>
      `data: ${JSON.stringify({
        id: `event-${index}`,
        name: "assistant.delta",
        sessionId: "active",
        turnId: "turn-1",
        timestamp: "2026-07-01T00:00:00.000Z",
        output: "x",
      })}\n\n`
    ).join("");

    await readTerminalEventStream(
      eventStreamResponse(frames),
      () => "active",
      (event) => {
        transcript = appendRuntimeEvent(transcript, event);
        scheduler.request();
      },
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ kind: "assistant", text: "x".repeat(100), streaming: true });
    expect(renders).toBe(0);
    expect(timers.pendingCount()).toBe(1);

    timers.runNext();

    expect(renders).toBe(1);
  });

  test("keeps high-frequency replay under render and active transcript memory budgets", async () => {
    const replayEventCount = 1_000;
    const maxScheduledPaints = 1;
    const maxPeakActiveTranscriptBytes = 64 * 1024;
    const timers = fakeTimers();
    let renders = 0;
    let renderRequests = 0;
    let replayedEvents = 0;
    let peakActiveTranscriptBytes = 0;
    let transcript: TranscriptItem[] = [];
    const scheduler = createTerminalUiRenderScheduler(() => {
      renders += 1;
    }, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const frames = Array.from({ length: replayEventCount }, (_, index) =>
      `data: ${JSON.stringify({
        id: `budget-event-${index}`,
        name: "assistant.delta",
        sessionId: "active",
        turnId: "turn-budget",
        timestamp: "2026-07-01T00:00:00.000Z",
        output: "x",
      })}\n\n`
    ).join("");

    await readTerminalEventStream(
      eventStreamResponse(frames),
      () => "active",
      (event) => {
        replayedEvents += 1;
        transcript = appendRuntimeEvent(transcript, event);
        peakActiveTranscriptBytes = Math.max(peakActiveTranscriptBytes, estimatedTranscriptBytes(transcript));
        renderRequests += 1;
        scheduler.request();
      },
    );

    expect(replayedEvents).toBe(replayEventCount);
    expect(renderRequests).toBe(replayEventCount);
    expect(transcript).toHaveLength(1);
    expect(peakActiveTranscriptBytes).toBeLessThanOrEqual(maxPeakActiveTranscriptBytes);
    expect(renders).toBe(0);
    expect(timers.pendingCount()).toBe(1);

    timers.runNext();

    expect(renders).toBeLessThanOrEqual(maxScheduledPaints);
  });
});

describe("terminal command scheduling", () => {
  function fakeTimers() {
    let nextId = 1;
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    return {
      setTimer(callback: () => void, delayMs: number) {
        const id = nextId++;
        timers.set(id, { callback, delayMs });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer(timer: ReturnType<typeof setTimeout>) {
        timers.delete(timer as unknown as number);
      },
      pendingCount() {
        return timers.size;
      },
      delays() {
        return [...timers.values()].map((timer) => timer.delayMs);
      },
      runNext() {
        const entry = timers.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
        if (!entry) throw new Error("No timer is pending");
        timers.delete(entry[0]);
        entry[1].callback();
      },
    };
  }

  test("runs lifecycle commands serially in submission order", async () => {
    const scheduler = createSerialTaskScheduler();
    const events: string[] = [];
    let releaseFirst: () => void;
    let markFirstStarted: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let secondFinished = false;

    const first = scheduler.run(async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
      return "first";
    });
    const second = scheduler.run(() => {
      events.push("second");
      secondFinished = true;
      return "second";
    });

    await firstStarted;

    expect(events).toEqual(["first:start"]);
    expect(secondFinished).toBe(false);

    releaseFirst();

    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  test("continues serial command scheduling after a failed command", async () => {
    const scheduler = createSerialTaskScheduler();

    await expect(scheduler.run(() => {
      throw new Error("command failed");
    })).rejects.toThrow("command failed");

    await expect(scheduler.run(() => "next command")).resolves.toBe("next command");
  });

  test("coalesces resize redraws with latest request winning", () => {
    const timers = fakeTimers();
    const calls: string[] = [];
    const scheduler = createLatestWinsTaskScheduler({
      delayMs: 20,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request(() => calls.push("first"));
    scheduler.request(() => calls.push("second"));
    scheduler.request(() => calls.push("third"));

    expect(calls).toEqual([]);
    expect(timers.pendingCount()).toBe(1);
    expect(timers.delays()).toEqual([20]);

    timers.runNext();

    expect(calls).toEqual(["third"]);
    expect(timers.pendingCount()).toBe(0);
  });

  test("guards fullscreen turn submissions with a Ctrl+C interrupt message", () => {
    const guard = createTerminalTurnSubmissionGuard();

    expect(guard.tryStartSubmission()).toBe(true);
    expect(guard.tryStartSubmission()).toBe(false);
    expect(TERMINAL_TURN_RUNNING_MESSAGE).toContain("turn is already running");
    expect(TERMINAL_TURN_RUNNING_MESSAGE).toContain("Ctrl+C");

    guard.applyRuntimeEvent(runtimeEvent({ id: "turn-interrupted", name: "turn.interrupted" }));

    expect(guard.tryStartSubmission()).toBe(true);
  });
});

describe("terminal transcript stable event ids", () => {
  test("resolves approvals by approval id instead of runtime event id", () => {
    let transcript: TranscriptItem[] = [];
    transcript = appendRuntimeEvent(
      transcript,
      runtimeEvent({
        id: "event-approval-requested",
        name: "approval.requested",
        action: "create_plan",
        status: "pending",
        output: "Approve Create plan",
        data: { id: "approval-create-plan" },
      }),
    );

    transcript = appendRuntimeEvent(
      transcript,
      runtimeEvent({
        id: "event-approval-resolved",
        name: "approval.resolved",
        action: "create_plan",
        status: "completed",
        data: { approvalId: "approval-create-plan" },
      }),
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: "approval-create-plan",
      kind: "approval",
      status: "approved",
    });
  });

  test("updates provider tool rows by stable call id", () => {
    let transcript: TranscriptItem[] = [];
    transcript = appendRuntimeEvent(
      transcript,
      runtimeEvent({
        id: "event-tool-started",
        name: "tool.started",
        action: "exec_command",
        status: "started",
        output: "pnpm test",
        data: { callId: "call-1" },
      }),
    );

    transcript = appendRuntimeEvent(
      transcript,
      runtimeEvent({
        id: "event-tool-completed",
        name: "tool.completed",
        action: "exec_command",
        status: "completed",
        output: "pass",
        data: { callId: "call-1" },
      }),
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: "tool-call-1",
      kind: "tool",
      status: "succeeded",
      summary: "pass",
    });
  });

  test("updates workspace action rows by workspace tool call id", () => {
    let transcript: TranscriptItem[] = [];
    transcript = appendRuntimeEvent(
      transcript,
      runtimeEvent({
        id: "event-workspace-started",
        name: "workspace_action",
        action: "save_file",
        status: "started",
        data: { workspaceToolCallId: "workspace-call-1" },
      }),
    );

    transcript = appendRuntimeEvent(
      transcript,
      runtimeEvent({
        id: "event-workspace-completed",
        name: "workspace_action_result",
        action: "save_file",
        status: "completed",
        output: "saved",
        data: { workspaceToolCallId: "workspace-call-1" },
      }),
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: "workspace-workspace-call-1",
      kind: "tool",
      status: "succeeded",
      summary: "saved",
    });
  });
});

describe("terminal active transcript buffer", () => {
  test("commits ready rows and removes them from the active transcript", () => {
    const streamingAssistant: TranscriptItem = {
      id: "assistant-streaming",
      kind: "assistant",
      text: "working",
      streaming: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const pendingApproval: TranscriptItem = {
      id: "approval-pending",
      kind: "approval",
      title: "Approve",
      body: "Review",
      status: "pending",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const readyUser: TranscriptItem = {
      id: "user-ready",
      kind: "user",
      text: "hello",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const readyTool: TranscriptItem = {
      id: "tool-ready",
      kind: "tool",
      title: "exec",
      summary: "done",
      status: "succeeded",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const committed = commitReadyTranscriptItems([
      readyUser,
      streamingAssistant,
      pendingApproval,
      readyTool,
    ]);

    expect(committed.readyItems.map((item) => item.id)).toEqual(["user-ready", "tool-ready"]);
    expect(committed.activeItems.map((item) => item.id)).toEqual(["assistant-streaming", "approval-pending"]);
  });

  test("caps active transcript rows as a ring buffer", () => {
    const items = Array.from({ length: 8 }, (_, index): TranscriptItem => ({
      id: `item-${index}`,
      kind: "assistant",
      text: `${index}`,
      streaming: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    }));

    expect(limitActiveTranscriptItems(items, 3).map((item) => item.id)).toEqual([
      "item-5",
      "item-6",
      "item-7",
    ]);
    expect(appendTranscriptItem(items.slice(0, 2), items[2]!, 2).map((item) => item.id)).toEqual([
      "item-1",
      "item-2",
    ]);
  });

  test("runtime event appends keep only the active transcript tail", () => {
    const base = Array.from({ length: 201 }, (_, index): TranscriptItem => ({
      id: `item-${index}`,
      kind: "assistant",
      text: `${index}`,
      streaming: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    }));

    const next = appendRuntimeEvent(
      base,
      runtimeEvent({
        id: "new-command",
        name: "command.output",
        action: "test",
        output: "ok",
      }),
    );

    expect(next).toHaveLength(200);
    expect(next[0]?.id).toBe("item-2");
    expect(next.at(-1)?.id).toBe("new-command");
  });

  test("bounds a single streaming assistant item by bytes", () => {
    let transcript: TranscriptItem[] = [];
    transcript = appendRuntimeEvent(transcript, runtimeEvent({
      id: "large-stream",
      name: "assistant.delta",
      turnId: "turn-large",
      output: "x".repeat(10 * 1024 * 1024),
    }));
    transcript = appendRuntimeEvent(transcript, runtimeEvent({
      id: "ignored-after-cap",
      name: "assistant.delta",
      turnId: "turn-large",
      output: "ignored",
    }));

    const assistant = transcript[0];
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected assistant transcript item");
    expect(new TextEncoder().encode(assistant.text).byteLength).toBeLessThanOrEqual(MAX_ACTIVE_STREAMING_TEXT_BYTES);
    expect(assistant.text).toContain("live output truncated");
    expect(assistant.text).not.toContain("ignored");
  });
});

describe("terminal project resolution", () => {
  test("resolves local projects by id and carries desktop-aligned workspace metadata", () => {
    const target = resolveTerminalProjectTarget(terminalBootstrapFixture(), "local_project_1");

    expect(target).toMatchObject({
      kind: "local_project",
      id: "local_project_1",
      label: "Local Website",
      session: {
        appId: "app_linked",
        appName: "Linked App",
        workspaceKind: "local_project",
        workspaceId: "local_project_1",
        workspaceName: "Local Website",
        localProjectId: "local_project_1",
        cloudProjectId: "cloud_linked",
        cloudTeamId: "team_1",
        cwd: "/repo/site",
      },
    });
  });

  test("resolves cloud projects by slug and uses the OpenPond sandbox session shape", () => {
    const target = resolveTerminalProjectTarget(terminalBootstrapFixture(), "cloud-worker");

    expect(target).toMatchObject({
      kind: "cloud_project",
      id: "cloud_project_1",
      provider: "openpond",
      session: {
        appId: null,
        appName: null,
        workspaceKind: "sandbox",
        workspaceId: "cloud_project_1",
        workspaceName: "Cloud Worker",
        cloudProjectId: "cloud_project_1",
        cloudTeamId: "team_2",
        cwd: null,
      },
    });
  });

  test("resolves OpenPond apps by name and formats all terminal project kinds", () => {
    const payload = terminalBootstrapFixture();
    const target = resolveTerminalProjectTarget(payload, "Hosted App");

    expect(target).toMatchObject({
      kind: "sandbox_app",
      id: "app_1",
      label: "Hosted App",
      session: {
        appId: "app_1",
        appName: "Hosted App",
        workspaceKind: "sandbox_app",
        workspaceId: "app_1",
      },
    });
    expect(formatTerminalProjects(payload)).toContain("local  local_project_1  Local Website");
    expect(formatTerminalProjects(payload)).toContain("cloud  cloud_project_1  Cloud Worker (cloud-worker)");
    expect(formatTerminalProjects(payload)).toContain("app    app_1  Hosted App");
  });
});

describe("terminal line-mode turn guard", () => {
  test("blocks duplicate line submissions until the running turn completes", () => {
    const guard = createLineModeTurnGuard();

    expect(guard.tryStartSubmission()).toBe(true);
    expect(guard.isRunning()).toBe(true);
    expect(guard.tryStartSubmission()).toBe(false);

    guard.applyRuntimeEvent(runtimeEvent({ id: "turn-done", name: "turn.completed" }));

    expect(guard.isRunning()).toBe(false);
    expect(guard.tryStartSubmission()).toBe(true);
  });

  test("clears running state for failed requests and failed/interrupted runtime events", () => {
    const guard = createLineModeTurnGuard();

    expect(guard.tryStartSubmission()).toBe(true);
    guard.failSubmission();
    expect(guard.isRunning()).toBe(false);

    guard.applyRuntimeEvent(runtimeEvent({ id: "turn-started", name: "turn.started" }));
    expect(guard.tryStartSubmission()).toBe(false);

    guard.applyRuntimeEvent(runtimeEvent({ id: "turn-failed", name: "turn.failed" }));
    expect(guard.tryStartSubmission()).toBe(true);

    guard.applyRuntimeEvent(runtimeEvent({ id: "turn-started-again", name: "turn.started" }));
    guard.applyRuntimeEvent(runtimeEvent({ id: "turn-interrupted", name: "turn.interrupted" }));
    expect(guard.isRunning()).toBe(false);
  });

  test("uses a clear line-mode duplicate-submit warning", () => {
    expect(LINE_MODE_TURN_RUNNING_MESSAGE).toContain("turn is already running");
    expect(LINE_MODE_TURN_RUNNING_MESSAGE).toContain("finish");
  });
});
