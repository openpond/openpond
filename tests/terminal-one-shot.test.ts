import path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { startFetchTestServer } from "./helpers/fetch-test-server";
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
const tsxBinary = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

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

describe("terminal argument parser", () => {
  test("defaults to OpenPond Chat and the supplied working directory", () => {
    expect(parseTerminalArgs([], "/repo")).toEqual({
      command: "chat",
      options: {
        server: "http://127.0.0.1:17874",
        provider: "openpond",
        model: null,
        cwd: "/repo",
        project: null,
        resume: null,
        noServerStart: false,
        message: null,
        messageFile: null,
        stdin: false,
        nonInteractive: false,
        json: false,
        yes: false,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        timeoutSec: null,
        maxOutputBytes: null,
      },
    });
  });

  test("parses provider/model shorthand plus project and resume flags", () => {
    expect(
      parseTerminalArgs(
        [
          "chat",
          "--server",
          "http://127.0.0.1:19000",
          "--provider",
          "openai",
          "--model",
          "openrouter/anthropic/claude-sonnet",
          "--cwd",
          "/repo/project",
          "--project",
          "local_project_1",
          "--resume",
          "session_1",
          "--no-server-start",
        ],
        "/repo"
      )
    ).toEqual({
      command: "chat",
      options: {
        server: "http://127.0.0.1:19000",
        provider: "openrouter",
        model: "anthropic/claude-sonnet",
        cwd: "/repo/project",
        cwdExplicit: true,
        project: "local_project_1",
        resume: "session_1",
        noServerStart: true,
        message: null,
        messageFile: null,
        stdin: false,
        nonInteractive: false,
        json: false,
        yes: false,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        timeoutSec: null,
        maxOutputBytes: null,
      },
    });
  });

  test("parses one-shot chat options and keeps trust controls explicit", () => {
    const parsed = parseTerminalArgs(
      [
        "chat",
        "--message",
        "fix the failing test",
        "--stdin",
        "--non-interactive",
        "--json",
        "--yes",
        "--approval-policy",
        "never",
        "--sandbox",
        "danger-full-access",
        "--timeout-sec",
        "120",
        "--max-output-bytes",
        "4096",
      ],
      "/repo",
    );

    expect(parsed.options).toMatchObject({
      message: "fix the failing test",
      stdin: true,
      nonInteractive: true,
      json: true,
      yes: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      timeoutSec: 120,
      maxOutputBytes: 4096,
    });
    expect(shouldRunOneShotChat(parsed.options)).toBe(true);
  });

  test("marks invalid one-shot option values as usage errors", () => {
    expect(() => parseTerminalArgs(["chat", "--timeout-sec", "soon"], "/repo")).toThrow(
      /timeout-sec must be a positive integer/,
    );
    try {
      parseTerminalArgs(["chat", "--timeout-sec", "soon"], "/repo");
      throw new Error("expected parseTerminalArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalUsageError);
      expect((error as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  test("routes chat modes without stealing existing interactive and pipe line-mode paths", () => {
    const baseOptions = parseTerminalArgs(["chat"], "/repo").options;
    const oneShotOptions = parseTerminalArgs(["chat", "--message", "run this"], "/repo").options;

    expect(resolveTerminalChatMode(baseOptions, { inputIsTTY: true, outputIsTTY: true })).toBe("interactive");
    expect(resolveTerminalChatMode(baseOptions, { inputIsTTY: false, outputIsTTY: true })).toBe("line-mode");
    expect(resolveTerminalChatMode(baseOptions, { inputIsTTY: true, outputIsTTY: false })).toBe("line-mode");
    expect(resolveTerminalChatMode(oneShotOptions, { inputIsTTY: false, outputIsTTY: false })).toBe("one-shot");
  });

  test("direct terminal usage advertises the headless trust controls", async () => {
    const result = await runProcessCommand(
      tsxBinary,
      [path.join(REPO_ROOT, "apps", "terminal", "src", "index.ts"), "help"],
      { timeoutMs: 5_000 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: openpond-app chat");
    expect(result.stdout).toContain("[--approval-policy POLICY]");
    expect(result.stdout).toContain("[--sandbox MODE]");
  });
});

describe("terminal one-shot chat result accumulator", () => {
  test("collects assistant output and terminal completion metadata", () => {
    const accumulator = createOneShotAccumulator();

    accumulator.apply(runtimeEvent({
      id: "event-1",
      name: "assistant.delta",
      turnId: "turn-1",
      output: "done",
    }));
    accumulator.apply(runtimeEvent({
      id: "event-2",
      name: "command.output",
      turnId: "turn-1",
      output: "pnpm test",
    }));
    accumulator.apply(runtimeEvent({
      id: "event-3",
      name: "tool.completed",
      action: "exec_command",
      turnId: "turn-1",
      output: "Command completed successfully.",
    }));
    accumulator.apply(runtimeEvent({
      id: "event-4",
      name: "workspace_action_result",
      turnId: "turn-1",
      output: "saved",
    }));

    const result = accumulator.result({
      terminal: "turn.completed",
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5",
      cwd: "/repo",
      startedAt: "2026-07-06T00:00:00.000Z",
      startedAtMs: Date.now(),
      error: null,
    });

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "openai",
      model: "gpt-5",
      cwd: "/repo",
      finalMessage: "done",
      events: {
        terminal: "turn.completed",
        total: 4,
        commands: 2,
        workspaceActions: 1,
      },
      usage: null,
      error: null,
    });
  });

  test("maps failed, interrupted, timeout, and pre-turn error terminal states", () => {
    for (const [terminal, expectedStatus] of [
      ["turn.failed", "failed"],
      ["turn.interrupted", "interrupted"],
      ["timeout", "timeout"],
      ["error", "failed"],
    ] as const) {
      const result = createOneShotAccumulator().result({
        terminal,
        sessionId: terminal === "error" ? null : "session-1",
        provider: "openpond",
        model: null,
        cwd: "/repo",
        startedAt: "2026-07-06T00:00:00.000Z",
        startedAtMs: Date.now(),
        error: expectedStatus === "failed" ? "boom" : null,
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.events.terminal).toBe(terminal);
      if (terminal === "error") expect(result.sessionId).toBeNull();
    }
  });

  test("caps final assistant output when max output bytes is set", () => {
    const accumulator = createOneShotAccumulator({ maxOutputBytes: 5 });

    accumulator.apply(runtimeEvent({
      id: "event-1",
      name: "assistant.delta",
      output: "hello world",
    }));

    const result = accumulator.result({
      terminal: "turn.completed",
      sessionId: "session-1",
      provider: "openpond",
      model: "openpond-chat",
      cwd: "/repo",
      startedAt: "2026-07-06T00:00:00.000Z",
      startedAtMs: Date.now(),
      error: null,
    });

    expect(result.finalMessage).toBe("hello");
    expect(result.output).toEqual({
      finalMessageBytes: 5,
      truncated: true,
      maxOutputBytes: 5,
    });
  });

  test("captures authoritative context usage snapshots and ignores heuristic snapshots", () => {
    const accumulator = createOneShotAccumulator();
    accumulator.apply(runtimeEvent({
      id: "event-heuristic-usage",
      name: "session.context.updated",
      turnId: "turn-1",
      data: {
        provider: "openpond",
        model: "openpond-chat",
        usedTokens: 80,
        maxContextTokens: 128000,
        usableContextTokens: 117760,
        percentFull: 1,
        source: "heuristic",
        updatedAtEventId: "event-heuristic-usage",
      },
    }));
    accumulator.apply(runtimeEvent({
      id: "event-provider-usage",
      name: "session.context.updated",
      turnId: "turn-1",
      data: {
        provider: "openpond",
        model: "openpond-chat",
        usedTokens: 123,
        maxContextTokens: 128000,
        usableContextTokens: 117760,
        percentFull: 1,
        source: "provider_usage",
        updatedAtEventId: "event-provider-usage",
      },
    }));

    const result = accumulator.result({
      terminal: "turn.completed",
      sessionId: "session-1",
      provider: "openpond",
      model: "openpond-chat",
      cwd: "/repo",
      startedAt: "2026-07-06T00:00:00.000Z",
      startedAtMs: Date.now(),
      error: null,
    });

    expect(result.usage).toEqual({
      provider: "openpond",
      model: "openpond-chat",
      usedTokens: 123,
      maxContextTokens: 128000,
      usableContextTokens: 117760,
      percentFull: 1,
      source: "provider_usage",
      updatedAtEventId: "event-provider-usage",
    });
  });
});

describe("terminal one-shot chat runner", () => {
  test("rejects ambiguous one-shot input sources before contacting the server", async () => {
    const options = parseTerminalArgs(["chat", "--message", "from message", "--stdin", "--non-interactive"], "/repo").options;

    try {
      await runOneShotChat(options, { input: Readable.from(["from stdin"]) });
      throw new Error("expected runOneShotChat to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalOneShotExitError);
      expect((error as { exitCode?: number }).exitCode).toBe(2);
      expect(error).toHaveProperty(
        "message",
        "openpond chat --non-interactive accepts exactly one instruction source; received --message, --stdin.",
      );
    }
  });

  test("submits one turn, waits for terminal completion, and emits structured JSON", async () => {
    const fake = await startOneShotFakeServer([
      runtimeEvent({
        id: "event-assistant",
        name: "assistant.delta",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        output: "Task complete.",
      }),
      runtimeEvent({
        id: "event-provider-usage",
        name: "session.context.updated",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        data: {
          provider: "openpond",
          model: "openpond-chat",
          usedTokens: 456,
          maxContextTokens: 128000,
          usableContextTokens: 117760,
          percentFull: 1,
          source: "provider_usage",
          updatedAtEventId: "event-provider-usage",
        },
      }),
      runtimeEvent({
        id: "event-completed",
        name: "turn.completed",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        output: "done",
      }),
    ]);
    const output = createStringWritable();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const result = await runOneShotChat(
        parseTerminalArgs(
          [
            "chat",
            "--server",
            fake.url,
            "--message",
            "Run the benchmark task",
            "--non-interactive",
            "--json",
            "--yes",
            "--sandbox",
            "workspace-write",
            "--timeout-sec",
            "5",
          ],
          "/bench/task",
        ).options,
        {
          output: output.stream,
          connection: { server: fake.url, token: "test-token" },
        },
      );

      const printed = JSON.parse(output.text()) as typeof result;
      expect(result.status).toBe("completed");
      expect(printed.status).toBe("completed");
      expect(printed.finalMessage).toBe("Task complete.");
      expect(printed.usage).toMatchObject({
        provider: "openpond",
        model: "openpond-chat",
        usedTokens: 456,
        source: "provider_usage",
      });
      expect(fake.turnRequests).toHaveLength(1);
      expect(fake.turnRequests[0]).toMatchObject({
        prompt: "Run the benchmark task",
        cwd: "/bench/task",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        metadata: {
          openpondTerminalMode: "one-shot",
          openpondTerminal: {
            mode: "one-shot",
            nonInteractive: true,
            sandbox: "workspace-write",
          },
        },
      });
      expect(fake.sessionRequests[0]).toMatchObject({
        openPondCommandAccessMode: "full-access",
        metadata: {
          openpondTerminalMode: "one-shot",
          openpondTerminal: {
            mode: "one-shot",
            sandbox: "workspace-write",
          },
        },
      });
    } finally {
      process.exitCode = previousExitCode;
      fake.stop();
    }
  });

  test("waits for the event stream to connect before posting a one-shot turn", async () => {
    let releaseEventStream!: () => void;
    const eventStreamGate = new Promise<void>((resolve) => {
      releaseEventStream = resolve;
    });
    const fake = await startOneShotFakeServer(
      [
        runtimeEvent({
          id: "event-completed",
          name: "turn.completed",
          sessionId: "session-one-shot",
          turnId: "turn-one-shot",
          output: "done",
        }),
      ],
      { eventStreamGate },
    );
    const output = createStringWritable();

    try {
      const running = runOneShotChat(
        parseTerminalArgs(
          [
            "chat",
            "--server",
            fake.url,
            "--message",
            "Run after stream connects",
            "--non-interactive",
            "--json",
            "--timeout-sec",
            "5",
          ],
          "/bench/task",
        ).options,
        {
          output: output.stream,
          connection: { server: fake.url, token: "test-token" },
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.turnRequests).toHaveLength(0);
      releaseEventStream();
      const result = await running;
      expect(result.status).toBe("completed");
      expect(fake.turnRequests).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("reconnects the event stream before posting a one-shot turn", async () => {
    const fake = await startOneShotFakeServer(
      [
        runtimeEvent({
          id: "event-completed",
          name: "turn.completed",
          sessionId: "session-one-shot",
          turnId: "turn-one-shot",
          output: "done",
        }),
      ],
      { eventStreamFailuresBeforeReady: 1 },
    );
    const output = createStringWritable();

    try {
      const result = await runOneShotChat(
        parseTerminalArgs(
          [
            "chat",
            "--server",
            fake.url,
            "--message",
            "Run after stream reconnects",
            "--non-interactive",
            "--json",
            "--timeout-sec",
            "2",
          ],
          "/bench/task",
        ).options,
        {
          output: output.stream,
          connection: { server: fake.url, token: "test-token" },
        },
      );

      expect(result.status).toBe("completed");
      expect(fake.eventStreamRequests).toBe(2);
      expect(fake.turnRequests).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("times out before posting a turn when the event stream never connects", async () => {
    const fake = await startOneShotFakeServer([], { eventStreamGate: new Promise(() => undefined) });
    const output = createStringWritable();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const options = parseTerminalArgs(
        [
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run only if stream connects",
          "--non-interactive",
          "--json",
          "--timeout-sec",
          "1",
        ],
        "/bench/task",
      ).options;
      options.timeoutSec = 0.05;

      const result = await runOneShotChat(options, {
        output: output.stream,
        connection: { server: fake.url, token: "test-token" },
      });

      const printed = JSON.parse(output.text()) as typeof result;
      expect(result.status).toBe("timeout");
      expect(printed.status).toBe("timeout");
      expect(process.exitCode).toBe(124);
      expect(fake.turnRequests).toHaveLength(0);
      expect(fake.interruptRequests).toBe(0);
    } finally {
      process.exitCode = previousExitCode ?? 0;
      fake.stop();
    }
  });

  test("streams human-readable output when JSON is not requested", async () => {
    const fake = await startOneShotFakeServer([
      runtimeEvent({
        id: "event-assistant",
        name: "assistant.delta",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        output: "Human task complete.",
      }),
      runtimeEvent({
        id: "event-command",
        name: "command.output",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        output: "pnpm test",
      }),
      runtimeEvent({
        id: "event-workspace",
        name: "workspace_action_result",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        output: "updated file",
      }),
      runtimeEvent({
        id: "event-completed",
        name: "turn.completed",
        sessionId: "session-one-shot",
        turnId: "turn-one-shot",
        output: "done",
      }),
    ]);
    const output = createStringWritable();

    try {
      const result = await runOneShotChat(
        parseTerminalArgs(
          [
            "chat",
            "--server",
            fake.url,
            "--message",
            "Run the human output task",
            "--non-interactive",
            "--timeout-sec",
            "5",
          ],
          "/bench/task",
        ).options,
        {
          output: output.stream,
          connection: { server: fake.url, token: "test-token" },
        },
      );

      const printed = output.text();
      expect(result.status).toBe("completed");
      expect(printed).toContain("OpenPond / OpenPond Chat /bench/task");
      expect(printed).toContain("Human task complete.");
      expect(printed).toContain("[command] pnpm test");
      expect(printed).toContain("[openpond] updated file");
      expect(printed).toContain("[turn completed]");
      expect(printed).not.toContain('"status":');
      expect(fake.turnRequests).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("interrupts the active turn and exits 124 when one-shot chat times out", async () => {
    const fake = await startOneShotFakeServer([]);
    const output = createStringWritable();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const options = parseTerminalArgs(
        [
          "chat",
          "--server",
          fake.url,
          "--message",
          "Run until timeout",
          "--non-interactive",
          "--json",
          "--timeout-sec",
          "1",
        ],
        "/bench/task",
      ).options;
      options.timeoutSec = 0.05;

      const result = await runOneShotChat(options, {
        output: output.stream,
        connection: { server: fake.url, token: "test-token" },
      });

      const printed = JSON.parse(output.text()) as typeof result;
      expect(result.status).toBe("timeout");
      expect(printed.status).toBe("timeout");
      expect(printed.error).toBe("Timed out after 0.05s during turn completion.");
      expect(process.exitCode).toBe(124);
      expect(fake.turnRequests).toHaveLength(1);
      expect(fake.interruptRequests).toBe(1);
    } finally {
      process.exitCode = previousExitCode ?? 0;
      fake.stop();
    }
  });
});

function createStringWritable(): { stream: Writable; text: () => string } {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    }),
    text: () => text,
  };
}

async function startOneShotFakeServer(
  events: RuntimeEvent[],
  options: { eventStreamGate?: Promise<void>; eventStreamFailuresBeforeReady?: number } = {},
): Promise<{
  url: string;
  sessionRequests: Record<string, unknown>[];
  turnRequests: Record<string, unknown>[];
  interruptRequests: number;
  eventStreamRequests: number;
  stop: () => void;
}> {
  const encoder = new TextEncoder();
  const eventControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const queuedFrames: string[] = [];
  const sessionRequests: Record<string, unknown>[] = [];
  const turnRequests: Record<string, unknown>[] = [];
  let interruptRequests = 0;
  let eventStreamRequests = 0;
  const now = "2026-07-06T00:00:00.000Z";

  function enqueueFrame(frame: string): void {
    if (eventControllers.size === 0) {
      queuedFrames.push(frame);
      return;
    }
    for (const controller of eventControllers) {
      controller.enqueue(encoder.encode(frame));
    }
  }

  function emitRuntimeEvent(event: RuntimeEvent): void {
    enqueueFrame(`data: ${JSON.stringify(event)}\n\n`);
  }

  const server = await startFetchTestServer(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/v1/bootstrap") return Response.json(terminalSessionBootstrapFixture());
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        sessionRequests.push(body);
        return Response.json({
          id: "session-one-shot",
          provider: body.provider ?? "openpond",
          modelRef: body.modelRef ?? null,
          openPondCommandAccessMode: body.openPondCommandAccessMode ?? "ask",
          title: body.title ?? "Terminal chat",
          appId: body.appId ?? null,
          appName: body.appName ?? null,
          cwd: body.cwd ?? null,
          codexThreadId: null,
          createdAt: now,
          updatedAt: now,
          status: "idle",
          pinned: false,
          archived: false,
          order: 0,
        });
      }
      if (url.pathname === "/v1/events") {
        eventStreamRequests += 1;
        if (eventStreamRequests <= (options.eventStreamFailuresBeforeReady ?? 0)) {
          return Response.json({ error: "event stream temporarily unavailable" }, { status: 503 });
        }
        await options.eventStreamGate;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              eventControllers.add(controller);
              controller.enqueue(encoder.encode('event: ready\ndata: {"ok": true}\n\n'));
              for (const frame of queuedFrames.splice(0)) {
                controller.enqueue(encoder.encode(frame));
              }
            },
            cancel() {
              eventControllers.clear();
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/session-one-shot/turns") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        turnRequests.push(body);
        queueMicrotask(() => {
          for (const event of events) emitRuntimeEvent(event);
        });
        return Response.json({ id: "turn-one-shot" }, { status: 202 });
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/session-one-shot/turns/interrupt") {
        interruptRequests += 1;
        return Response.json({ ok: true }, { status: 202 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
  });

  return {
    url: server.url,
    sessionRequests,
    turnRequests,
    get interruptRequests() {
      return interruptRequests;
    },
    get eventStreamRequests() {
      return eventStreamRequests;
    },
    stop: () => server.stop(),
  };
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
