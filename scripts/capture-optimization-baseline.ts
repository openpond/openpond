import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProviderSettingsSchema,
  type ProviderSettings,
  type RuntimeEvent,
  type Session,
  type WorkspaceDiffSummary,
} from "@openpond/contracts";

import { MessageRow, ThinkingIndicator } from "../apps/web/src/components/chat/Messages";
import { ProviderSettingsSection } from "../apps/web/src/components/settings/ProviderSettingsSection";
import { WorkspaceDiffPanel } from "../apps/web/src/components/workspace-diff/WorkspaceDiffPanel";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import { createOpenPondServer } from "../apps/server/src/index";
import { SqliteStore } from "../apps/server/src/store/store";
import { readTerminalEventStream } from "../apps/terminal/src/events";
import { createTerminalRenderScheduler } from "../apps/terminal/src/ui/render-scheduler";
import {
  appendRuntimeEvent,
  type TranscriptItem,
} from "../apps/terminal/src/ui/transcript";
import { createGoalState, normalizeGoalState } from "../apps/cli/src/goal/config";
import { runGoalLlmToolCall } from "../apps/cli/src/goal/tools/dispatch";
import { runProcessCommand } from "../apps/cli/src/process-runner";
import { collectProjectSourceUploadEntries } from "../apps/cli/src/cli/project-agent";
import {
  collectRendererBundleMetrics,
  measureServerStartup,
} from "./check-performance-budgets";
import { clearWorkspaceDiffCacheForTests, loadWorkspaceDiffAtPath } from "../apps/server/src/workspace/workspace-diff";

type BaselineOptions = {
  date: string;
  root: string;
  desktopAppPath: string | null;
  jsonPath: string;
  markdownPath: string;
  skipDesktop: boolean;
};

type CommandMetric = {
  command: string;
  code: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  ok: boolean;
  summary: string;
};

type BaselineReport = {
  generatedAt: string;
  root: string;
  platform: {
    os: NodeJS.Platform;
    arch: string;
    node: string;
    bun: string | null;
  };
  desktop: Awaited<ReturnType<typeof captureDesktopBaseline>>;
  startup: Awaited<ReturnType<typeof measureServerStartup>>;
  renderer: Awaited<ReturnType<typeof captureRendererBaseline>>;
  workspaceDiff: Awaited<ReturnType<typeof captureWorkspaceDiffBaseline>>;
  tui: Awaited<ReturnType<typeof captureTuiBaseline>>;
  cli: Awaited<ReturnType<typeof captureCliBaseline>>;
  eventStore: Awaited<ReturnType<typeof captureEventStoreBaseline>>;
  providerModel: Awaited<ReturnType<typeof captureProviderModelBaseline>>;
};

const NOW = "2026-07-01T12:00:00.000Z";
const noop = () => undefined;
const noopAsync = async () => undefined;

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseArgs(process.argv.slice(2), root);
  const tempDirs: string[] = [];

  try {
    const baseline: BaselineReport = {
      generatedAt: new Date().toISOString(),
      root,
      platform: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
        bun: typeof Bun !== "undefined" ? Bun.version : null,
      },
      desktop: await captureDesktopBaseline(options),
      startup: await measureServerStartup({ root, timeoutMs: 20_000 }),
      renderer: await captureRendererBaseline(root),
      workspaceDiff: await captureWorkspaceDiffBaseline(tempDirs),
      tui: await captureTuiBaseline(),
      cli: await captureCliBaseline(root, tempDirs),
      eventStore: await captureEventStoreBaseline(tempDirs),
      providerModel: await captureProviderModelBaseline(tempDirs),
    };

    await mkdir(path.dirname(options.jsonPath), { recursive: true });
    await writeFile(options.jsonPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    await writeFile(options.markdownPath, renderMarkdownBaseline(baseline, options), "utf8");
    console.log(JSON.stringify({
      ok: true,
      jsonPath: path.relative(root, options.jsonPath),
      markdownPath: path.relative(root, options.markdownPath),
    }, null, 2));
  } finally {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

function parseArgs(args: string[], root: string): BaselineOptions {
  const date = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(root, "docs", "working-docs", "optimization");
  const options: BaselineOptions = {
    date,
    root,
    desktopAppPath: null,
    jsonPath: path.join(outputDir, `${date}-phase0-baseline.json`),
    markdownPath: path.join(outputDir, `${date}-phase0-baseline.md`),
    skipDesktop: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log([
        "usage: bun scripts/capture-optimization-baseline.ts [options]",
        "",
        "Options:",
        "  --desktop-app <path>   Packaged desktop app path for the desktop timing probe.",
        "  --skip-desktop         Skip packaged desktop launch timing.",
        "  --json <path>          JSON output path.",
        "  --markdown <path>      Markdown output path.",
      ].join("\n"));
      process.exit(0);
    }
    if (arg === "--desktop-app") {
      options.desktopAppPath = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg.startsWith("--desktop-app=")) {
      options.desktopAppPath = path.resolve(arg.slice("--desktop-app=".length));
      continue;
    }
    if (arg === "--skip-desktop") {
      options.skipDesktop = true;
      continue;
    }
    if (arg === "--json") {
      options.jsonPath = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg.startsWith("--json=")) {
      options.jsonPath = path.resolve(arg.slice("--json=".length));
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = path.resolve(args[++index] ?? "");
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      options.markdownPath = path.resolve(arg.slice("--markdown=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function captureDesktopBaseline(options: BaselineOptions) {
  if (options.skipDesktop) {
    return { ok: false, skipped: true, reason: "--skip-desktop was provided" };
  }
  const appPath = options.desktopAppPath ?? defaultPackagedDesktopPath(options.root);
  if (!appPath) {
    return {
      ok: false,
      skipped: true,
      reason: "No packaged desktop app found; run package:linux, package:mac, or package:win first.",
    };
  }
  const command = process.env.BUN_BINARY || "bun";
  const args = [
    "run",
    "smoke:desktop:packaged",
    "--",
    "--app",
    appPath,
    "--timeout-ms",
    "60000",
  ];
  const startedAt = performance.now();
  const result = await runProcessCommand(command, args, {
    cwd: options.root,
    timeoutMs: 90_000,
    maxOutputBytes: 256 * 1024,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const parsed = parseLastJsonObject(result.stdout);
  return {
    ok: result.code === 0 && !result.timedOut && Boolean(parsed?.ok),
    skipped: false,
    command: `${command} ${args.join(" ")}`,
    appPath: path.relative(options.root, appPath),
    durationMs,
    code: result.code,
    timedOut: result.timedOut,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    smoke: parsed,
    error: result.code === 0 ? null : tailText(result.stderr || result.stdout),
  };
}

function defaultPackagedDesktopPath(root: string): string | null {
  const candidates = process.platform === "darwin"
    ? [
        path.join(root, "release", "mac", "openpond.app"),
        path.join(root, "release", "mac", "openpond nightly.app"),
        path.join(root, "release", "mac-arm64", "openpond.app"),
        path.join(root, "release", "mac-arm64", "openpond nightly.app"),
        path.join(root, "release", "mac-universal", "openpond.app"),
        path.join(root, "release", "mac-universal", "openpond nightly.app"),
      ]
    : process.platform === "win32"
      ? [
          path.join(root, "release", "win-unpacked", "openpond.exe"),
          path.join(root, "release", "win-unpacked", "openpond nightly.exe"),
          path.join(root, "release", "win-ia32-unpacked", "openpond.exe"),
          path.join(root, "release", "win-ia32-unpacked", "openpond nightly.exe"),
          path.join(root, "release", "win-arm64-unpacked", "openpond.exe"),
          path.join(root, "release", "win-arm64-unpacked", "openpond nightly.exe"),
        ]
      : [
          path.join(root, "release", "linux-unpacked", "openpond"),
          path.join(root, "release", "linux-unpacked", "openpond nightly"),
          path.join(root, "release", "openpond-0.0.1.AppImage"),
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function captureRendererBaseline(root: string) {
  const bundle = await collectRendererBundleMetrics(path.join(root, "apps", "web", "dist"));
  const scenario = measureStaticRender(
    createElement(
      "section",
      { className: "phase0-renderer-scenario" },
      Array.from({ length: 1_000 }, (_, index) =>
        createElement(MessageRow, {
          key: `message-${index}`,
          message: chatMessage(index),
          showFooter: index === 999,
        }),
      ),
      createElement(WorkspaceDiffPanel, {
        appId: "phase0-local-project",
        workspaceId: "phase0-local-project",
        workspaceKind: "local_project",
        connection: null,
        diff: workspaceDiffSummary(200),
        editorPreferences: null,
        loading: false,
        workspaceName: "Phase 0 local project",
        workspaceInitialized: true,
        workspaceError: null,
        expanded: true,
        onRefresh: noopAsync,
        onResizeStart: noop,
        onToggleExpanded: noop,
        onOpenBrowser: noop,
        onOpenBrowserUrl: noop,
      }),
      createElement(ThinkingIndicator),
    ),
  );
  return {
    bundle,
    scenario: {
      runtimeEvents: 1_000,
      chatRows: 1_000,
      diffFiles: 200,
      activeStreamingDeltas: true,
      ...scenario,
    },
    bundleCostBreakdown: rendererBundleCostBreakdown(bundle.largestAssets),
  };
}

async function captureWorkspaceDiffBaseline(tempDirs: string[]) {
  const repo = await tempDir(tempDirs, "openpond-phase0-diff-");
  await createChangedRepo(repo, 200);
  clearWorkspaceDiffCacheForTests();
  const rawLargePatch = await runProcessCommand("git", ["diff", "--", "src/module-0.ts"], {
    cwd: repo,
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (rawLargePatch.code !== 0) {
    throw new Error(`git diff for large patch failed: ${rawLargePatch.stderr || rawLargePatch.stdout}`);
  }
  const startedAt = performance.now();
  const diff = await loadWorkspaceDiffAtPath(repo, "phase0-diff", { includeFileDetails: true });
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const largestPatchBytes = Math.max(
    0,
    ...diff.files.map((file) => Buffer.byteLength(file.patch ?? "", "utf8")),
  );
  const rawLargePatchBytes = Buffer.byteLength(rawLargePatch.stdout, "utf8");
  return {
    repo,
    durationMs,
    filesChanged: diff.filesChanged,
    additions: diff.additions,
    deletions: diff.deletions,
    largestPatchBytes,
    rawLargePatchBytes,
    responseBytes: Buffer.byteLength(JSON.stringify(diff), "utf8"),
    hasLargePatch: rawLargePatchBytes > 64 * 1024,
  };
}

async function captureTuiBaseline() {
  const replayEventCount = 1_000;
  const timers = fakeTimers();
  let renders = 0;
  let renderRequests = 0;
  let replayedEvents = 0;
  let peakActiveTranscriptBytes = 0;
  let transcript: TranscriptItem[] = [];
  const scheduler = createTerminalRenderScheduler(() => {
    renders += 1;
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const frames = Array.from({ length: replayEventCount }, (_, index) =>
    `data: ${JSON.stringify(runtimeEvent({
      id: `phase0-tui-event-${index}`,
      name: "assistant.delta",
      sessionId: "phase0-session",
      turnId: "phase0-turn",
      output: "x",
    }))}\n\n`
  ).join("");
  const startedAt = performance.now();
  await readTerminalEventStream(
    eventStreamResponse(frames),
    () => "phase0-session",
    (event) => {
      replayedEvents += 1;
      transcript = appendRuntimeEvent(transcript, event);
      peakActiveTranscriptBytes = Math.max(peakActiveTranscriptBytes, estimatedTranscriptBytes(transcript));
      renderRequests += 1;
      scheduler.request();
    },
  );
  const replayMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const rendersBeforeFlush = renders;
  const pendingTimersBeforeFlush = timers.pendingCount();
  timers.runAll();
  return {
    replayEventCount,
    replayedEvents,
    renderRequests,
    rendersBeforeFlush,
    rendersAfterFlush: renders,
    pendingTimersBeforeFlush,
    replayMs,
    transcriptItems: transcript.length,
    peakActiveTranscriptBytes,
  };
}

async function captureCliBaseline(root: string, tempDirs: string[]) {
  const cliHelp = await commandMetric("cli --help", process.env.BUN_BINARY || "bun", ["run", "cli", "--", "--help"], {
    cwd: root,
    expectOk: (result) => result.code === 0 && result.stdout.includes("openpond"),
  });
  const serve = await runCliServeScenario(root, tempDirs);
  const tui = await runCliTuiScenario(root, tempDirs);
  const sourceUpload = await captureSourceUploadScenario(tempDirs);
  const goalTool = await captureGoalToolScenario(tempDirs);
  return {
    help: cliHelp,
    serve,
    tui,
    sourceUpload,
    goalTool,
  };
}

async function runCliServeScenario(root: string, tempDirs: string[]) {
  const home = await tempDir(tempDirs, "openpond-phase0-cli-serve-home-");
  const command = process.env.BUN_BINARY || "bun";
  const args = ["run", "cli", "--", "serve", "--port", "0"];
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  try {
    const ready = await new Promise<{ url: string; readyMs: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("serve CLI did not print server ready payload")), 20_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const payload = readyPayload(stdout);
        if (!payload) return;
        clearTimeout(timeout);
        resolve({ url: payload.url, readyMs: Math.round(performance.now() - startedAt) });
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve CLI exited before ready with code ${code ?? "unknown"}`));
      });
    });
    const healthStartedAt = performance.now();
    const health = await fetch(`${ready.url}/health`);
    return {
      command: `${command} ${args.join(" ")}`,
      ok: health.ok,
      readyMs: ready.readyMs,
      healthMs: Math.round((performance.now() - healthStartedAt) * 100) / 100,
      healthStatus: health.status,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      error: null,
    };
  } catch (error) {
    return {
      command: `${command} ${args.join(" ")}`,
      ok: false,
      readyMs: null,
      healthMs: null,
      healthStatus: null,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    killProcessTree(child.pid);
  }
}

async function runCliTuiScenario(root: string, tempDirs: string[]) {
  const home = await tempDir(tempDirs, "openpond-phase0-cli-tui-home-");
  const serverHome = path.join(home, ".openpond", "openpond-app");
  const server = await createOpenPondServer({
    port: 0,
    storeDir: serverHome,
    silent: true,
    version: "phase0-cli-tui-baseline",
  });
  try {
    return await commandMetric(
      "cli tui /exit",
      process.env.BUN_BINARY || "bun",
      ["run", "cli", "--", "tui", "--server", server.url, "--no-server-start"],
      {
        cwd: root,
        env: { HOME: home, USERPROFILE: home },
        stdin: "/exit\n",
        timeoutMs: 30_000,
        expectOk: (result) => result.code === 0 && result.stdout.includes("OpenPond"),
      },
    );
  } finally {
    await server.close();
  }
}

async function captureSourceUploadScenario(tempDirs: string[]) {
  const projectPath = await tempDir(tempDirs, "openpond-phase0-source-upload-");
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await writeFile(path.join(projectPath, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(projectPath, "src", "b.ts"), "export const b = 2;\n", "utf8");
  await writeFile(path.join(projectPath, ".env.local"), "SECRET=not-uploaded\n", "utf8");
  const startedAt = performance.now();
  const upload = await collectProjectSourceUploadEntries(projectPath);
  return {
    ok: upload.fileCount === 2 && upload.entries.every((entry) => !entry.path.includes(".env")),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    fileCount: upload.fileCount,
    totalBytes: upload.totalBytes,
    transport: upload.transport,
    limits: upload.limits,
    paths: upload.entries.map((entry) => entry.path),
  };
}

async function captureGoalToolScenario(tempDirs: string[]) {
  const workspace = await tempDir(tempDirs, "openpond-phase0-goal-tool-");
  const goal = normalizeGoalState(createGoalState({
    objective: "Write and read a phase 0 baseline artifact",
  }));
  const startedAt = performance.now();
  const write = await runGoalLlmToolCall(
    { goal, iterationId: "phase0-goal-tool", workspace },
    {
      id: "phase0-files-write",
      name: "files.write",
      arguments: {
        path: "phase0-report.txt",
        content: "phase 0 goal tool execution\n",
      },
    },
  );
  const read = await runGoalLlmToolCall(
    { goal, iterationId: "phase0-goal-tool", workspace },
    {
      id: "phase0-files-read",
      name: "files.read",
      arguments: {
        path: "phase0-report.txt",
      },
    },
  );
  return {
    ok: write.status === "ok" && read.status === "ok",
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    write,
    read,
  };
}

async function captureEventStoreBaseline(tempDirs: string[]) {
  const storeDir = await tempDir(tempDirs, "openpond-phase0-store-");
  const store = new SqliteStore(storeDir);
  const sessionId = "phase0-session";
  try {
    await store.insertSessionAtFront(session(sessionId));
    const appendStartedAt = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      await store.appendRuntimeEvent(runtimeEvent({
        id: `phase0-store-event-${index}`,
        name: index % 2 === 0 ? "assistant.delta" : "command.output",
        sessionId,
        turnId: "phase0-turn",
        output: `event ${index}`,
      }));
    }
    const appendMs = Math.round((performance.now() - appendStartedAt) * 100) / 100;
    const latestSequence = await store.latestEventSequence();
    const windowStartedAt = performance.now();
    const window = await store.recentRuntimeEventWindow(500);
    const windowMs = Math.round((performance.now() - windowStartedAt) * 100) / 100;
    const pageStartedAt = performance.now();
    const page = await store.runtimeEventPageRows({ sessionId, afterSequence: 0, limit: 1_000 });
    const pageMs = Math.round((performance.now() - pageStartedAt) * 100) / 100;
    const projectionStartedAt = performance.now();
    const projection = await store.threadDetailProjection(sessionId);
    const projectionMs = Math.round((performance.now() - projectionStartedAt) * 100) / 100;
    return {
      totalEvents: latestSequence,
      appendMs,
      bootstrapWindowLimit: window.limit,
      bootstrapWindowBytes: Buffer.byteLength(JSON.stringify(window), "utf8"),
      sequenceCatchUpBytes: Buffer.byteLength(JSON.stringify(page), "utf8"),
      sequenceCatchUpMs: pageMs,
      recentWindowMs: windowMs,
      projectionQueryMs: projectionMs,
      projection,
      pageEntries: page.entries.length,
      remainingMatchingEvents: page.remainingMatchingEvents,
    };
  } finally {
    await store.close();
  }
}

async function captureProviderModelBaseline(tempDirs: string[]) {
  const storeDir = await tempDir(tempDirs, "openpond-phase0-provider-");
  const server = await createOpenPondServer({
    port: 0,
    storeDir,
    silent: true,
    version: "phase0-provider-baseline",
  });
  try {
    const providers = await timedJson<ProviderSettings>(server.url, server.token, "/v1/providers");
    const modelDiscovery = await timedJson(server.url, server.token, "/v1/providers/codex/models", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const validation = await timedJson(server.url, server.token, "/v1/providers/codex/validate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const diagnostics = await timedJson(server.url, server.token, "/v1/diagnostics/providers");
    const latestProviders =
      providerSettingsFromPayload(validation.value) ??
      providerSettingsFromPayload(modelDiscovery.value) ??
      providers.value;
    const settingsRender = measureStaticRender(createElement(ProviderSettingsSection, {
      account: null,
      codex: null,
      providers: latestProviders,
      providerBusy: null,
      validationMessage: null,
      deleteProviderCredential: noopAsync,
      loadProviderModels: noopAsync,
      refreshProviderModels: noopAsync,
      saveProviderConfig: noopAsync,
      saveProviderCredential: noopAsync,
      validateProvider: noopAsync,
    }));
    const modelCacheSizes = Object.entries(latestProviders.modelCaches).map(([providerId, cache]) => ({
      providerId,
      models: cache.models.length,
      bytes: Buffer.byteLength(JSON.stringify(cache), "utf8"),
    })).sort((left, right) => right.bytes - left.bytes);
    return {
      ok: true,
      providerSettingsPayloadBytes: providers.responseBytes,
      providerSettingsDurationMs: providers.durationMs,
      modelDiscoveryDurationMs: modelDiscovery.durationMs,
      validationDurationMs: validation.durationMs,
      diagnosticsPayloadBytes: diagnostics.responseBytes,
      diagnostics: diagnostics.value,
      largestModelCache: modelCacheSizes[0] ?? null,
      modelCacheSizes,
      providerSettingsRenderCost: settingsRender,
    };
  } finally {
    await server.close();
  }
}

function providerSettingsFromPayload(value: unknown): ProviderSettings | null {
  const candidate = value && typeof value === "object" && !Array.isArray(value) && "providers" in value
    ? (value as { providers?: unknown }).providers
    : value;
  const parsed = ProviderSettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

async function timedJson<T = unknown>(
  serverUrl: string,
  token: string,
  routePath: string,
  init: RequestInit = {},
): Promise<{ value: T; durationMs: number; responseBytes: number; status: number }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const startedAt = performance.now();
  const response = await fetch(`${serverUrl}${routePath}`, { ...init, headers });
  const text = await response.text();
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (!response.ok) throw new Error(`${routePath} returned ${response.status}: ${tailText(text)}`);
  return {
    value: JSON.parse(text) as T,
    durationMs,
    responseBytes: Buffer.byteLength(text, "utf8"),
    status: response.status,
  };
}

async function commandMetric(
  label: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    expectOk?: (result: Awaited<ReturnType<typeof runProcessCommand>>) => boolean;
  },
): Promise<CommandMetric> {
  const startedAt = performance.now();
  const result = await runProcessCommand(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 128 * 1024,
  });
  const ok = options.expectOk ? options.expectOk(result) : result.code === 0 && !result.timedOut;
  return {
    command: `${command} ${args.join(" ")}`,
    code: result.code,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    timedOut: result.timedOut,
    ok,
    summary: ok ? firstLine(result.stdout) : tailText(result.stderr || result.stdout),
  };
}

function measureStaticRender(element: ReactElement): { durationMs: number; htmlBytes: number } {
  const startedAt = performance.now();
  const html = renderToStaticMarkup(element);
  return {
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    htmlBytes: Buffer.byteLength(html, "utf8"),
  };
}

function rendererBundleCostBreakdown(largestAssets: Array<{ path: string; bytes: number }>) {
  const groups = {
    monaco: 0,
    xterm: 0,
    lucide: 0,
    diffEditor: 0,
    otherLargest: 0,
  };
  for (const asset of largestAssets) {
    const name = asset.path.toLowerCase();
    if (name.includes("monaco") || name.includes("worker") || name.includes("workspace-monaco-editor")) {
      groups.monaco += asset.bytes;
    } else if (name.includes("terminal") || name.includes("xterm")) {
      groups.xterm += asset.bytes;
    } else if (name.includes("lucide") || name.includes("icon")) {
      groups.lucide += asset.bytes;
    } else if (name.includes("workspace-diff")) {
      groups.diffEditor += asset.bytes;
    } else {
      groups.otherLargest += asset.bytes;
    }
  }
  return groups;
}

async function createChangedRepo(repo: string, fileCount: number): Promise<void> {
  await runGit(repo, ["init"]);
  await runGit(repo, ["config", "user.email", "phase0@example.local"]);
  await runGit(repo, ["config", "user.name", "OpenPond Phase 0"]);
  await mkdir(path.join(repo, "src"), { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(path.join(repo, "src", `module-${index}.ts`), `export const value = ${index};\n`, "utf8");
  }
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-m", "initial phase0 fixture"]);
  for (let index = 0; index < fileCount; index += 1) {
    const body = index === 0
      ? Array.from({ length: 4_000 }, (_, line) => `export const large_${line} = ${line};`).join("\n")
      : `export const value = ${index + 1};\nexport const status = "changed";\n`;
    await writeFile(path.join(repo, "src", `module-${index}.ts`), `${body}\n`, "utf8");
  }
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = await runProcessCommand("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function workspaceDiffSummary(fileCount: number): WorkspaceDiffSummary {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/module-${index}.ts`,
    status: index % 5 === 0 ? "added" as const : "modified" as const,
    additions: 4,
    deletions: 1,
    patch: [
      `diff --git a/src/module-${index}.ts b/src/module-${index}.ts`,
      `--- a/src/module-${index}.ts`,
      `+++ b/src/module-${index}.ts`,
      "@@ -1,2 +1,5 @@",
      `-export const value = ${index};`,
      `+export const value = ${index + 1};`,
      "+export const status = 'ready';",
    ].join("\n"),
    content: `export const value = ${index + 1};\nexport const status = 'ready';\n`,
  }));
  return {
    appId: "phase0-local-project",
    repoPath: "/workspace/phase0-local-project",
    initialized: true,
    dirty: true,
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    repoFiles: files.map((file) => file.path),
    files,
    error: null,
    updatedAt: NOW,
  };
}

function chatMessage(index: number): ChatMessage {
  const role = index % 2 === 0 ? "user" : "assistant";
  return {
    id: `phase0-message-${index}`,
    role,
    content: role === "user"
      ? `Customer asks for support update ${index}.`
      : `Support stream update ${index}: blocked owner is assigned and next action is recorded.`,
    timestamp: NOW,
    turnId: `phase0-turn-${Math.floor(index / 2)}`,
  };
}

function runtimeEvent(input: Partial<RuntimeEvent> & Pick<RuntimeEvent, "id" | "name">): RuntimeEvent {
  return {
    timestamp: NOW,
    ...input,
  } as RuntimeEvent;
}

function session(id: string): Session {
  return {
    id,
    provider: "openpond",
    title: "Phase 0 baseline session",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: process.cwd(),
    codexThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

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
    runAll() {
      while (timers.size > 0) {
        const entry = timers.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
        if (!entry) return;
        timers.delete(entry[0]);
        entry[1].callback();
      }
    },
  };
}

function estimatedTranscriptBytes(items: TranscriptItem[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength;
}

async function tempDir(tempDirs: string[], prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readyPayload(stdout: string): { url: string } | null {
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("OPENPOND_APP_SERVER_READY "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice("OPENPOND_APP_SERVER_READY ".length)) as { url?: unknown };
    return typeof parsed.url === "string" ? { url: parsed.url } : null;
  } catch {
    return null;
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
      return;
    }
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(index)) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      // Try the previous opening brace.
    }
  }
  return null;
}

function renderMarkdownBaseline(
  baseline: BaselineReport,
  options: BaselineOptions,
): string {
  const desktop = baseline.desktop as Record<string, unknown>;
  const desktopSmoke = desktop.smoke as { timings?: Record<string, unknown> } | undefined;
  const startup = baseline.startup;
  return [
    `# ${options.date} Phase 0 Optimization Baseline`,
    "",
    `Generated by \`bun run baseline:optimization\` on ${baseline.platform.os}/${baseline.platform.arch}.`,
    "",
    "## Summary",
    "",
    "| Area | Metric | Result |",
    "| --- | --- | ---: |",
    `| Desktop | packaged smoke | ${desktop.ok ? "passed" : desktop.skipped ? "skipped" : "failed"} |`,
    `| Desktop | startup to preload bridge | ${formatNullableMs(numberValue(desktopSmoke?.timings?.desktopStartupMs))} |`,
    `| Desktop | renderer DOM ready | ${formatNullableMs(numberValue(desktopSmoke?.timings?.initialRendererReadyMs))} |`,
    `| Desktop | first chat input latency | ${formatNullableMs(numberValue(desktopSmoke?.timings?.firstChatInputLatencyMs))} |`,
    `| Server | ready | ${startup.ok ? formatMs(startup.serverReadyMs) : "failed"} |`,
    `| Server | health | ${startup.ok ? formatMs(startup.healthMs) : "failed"} |`,
    `| Server | bootstrap payload | ${startup.ok ? formatBytes(startup.routes.bootstrap.responseBytes) : "failed"} |`,
    `| Renderer | 1,000-event scenario render | ${formatMs(baseline.renderer.scenario.durationMs)} |`,
    `| Renderer | 1,000-event scenario HTML | ${formatBytes(baseline.renderer.scenario.htmlBytes)} |`,
    `| Workspace diff | 200 changed files with large patch | ${formatMs(baseline.workspaceDiff.durationMs)} |`,
    `| Workspace diff | raw large patch | ${formatBytes(baseline.workspaceDiff.rawLargePatchBytes)} |`,
    `| Workspace diff | response size | ${formatBytes(baseline.workspaceDiff.responseBytes)} |`,
    `| TUI | replay 1,000 deltas | ${formatMs(baseline.tui.replayMs)} |`,
    `| TUI | scheduled renders after flush | ${baseline.tui.rendersAfterFlush} |`,
    `| CLI | help | ${baseline.cli.help.ok ? "passed" : "failed"} |`,
    `| CLI | serve | ${baseline.cli.serve.ok ? "passed" : "failed"} |`,
    `| CLI | tui /exit | ${baseline.cli.tui.ok ? "passed" : "failed"} |`,
    `| CLI | source upload scan | ${baseline.cli.sourceUpload.ok ? "passed" : "failed"} |`,
    `| CLI | goal tool execution | ${baseline.cli.goalTool.ok ? "passed" : "failed"} |`,
    `| Event store | total events | ${baseline.eventStore.totalEvents} |`,
    `| Event store | bootstrap window bytes | ${formatBytes(baseline.eventStore.bootstrapWindowBytes)} |`,
    `| Event store | catch-up bytes | ${formatBytes(baseline.eventStore.sequenceCatchUpBytes)} |`,
    `| Event store | projection query | ${formatMs(baseline.eventStore.projectionQueryMs)} |`,
    `| Providers | settings payload | ${formatBytes(baseline.providerModel.providerSettingsPayloadBytes)} |`,
    `| Providers | largest model cache | ${baseline.providerModel.largestModelCache ? `${baseline.providerModel.largestModelCache.providerId} (${formatBytes(baseline.providerModel.largestModelCache.bytes)})` : "none"} |`,
    `| Providers | model discovery | ${formatMs(baseline.providerModel.modelDiscoveryDurationMs)} |`,
    `| Providers | validation | ${formatMs(baseline.providerModel.validationDurationMs)} |`,
    `| Providers | settings render | ${formatMs(baseline.providerModel.providerSettingsRenderCost.durationMs)} |`,
    "",
    "## Bundle Cost Breakdown",
    "",
    "| Group | Bytes in largest assets |",
    "| --- | ---: |",
    ...Object.entries(baseline.renderer.bundleCostBreakdown).map(([group, bytes]) =>
      `| ${group} | ${formatBytes(Number(bytes))} |`
    ),
    "",
    "Largest renderer assets:",
    "",
    ...baseline.renderer.bundle.largestAssets.map((asset) => `- \`${asset.path}\`: ${formatBytes(asset.bytes)}`),
    "",
    "## Notes",
    "",
    "- Desktop timing comes from the packaged Electron smoke path and includes a real preload bridge check, local server health request, browser sidebar open/close, and composer input latency probe.",
    "- Renderer timing is a server-side React render of 1,000 chat rows, an open 200-file diff panel, and an active thinking indicator.",
    "- Workspace diff timing uses a real temporary Git repository with 200 modified files and one large patch.",
    "- TUI timing replays 1,000 real SSE `assistant.delta` frames through the terminal event parser, transcript reducer, and render scheduler.",
    "- CLI timing includes real `--help`, `serve`, and `tui` command paths plus source-upload and goal-tool execution scenarios.",
    `- Raw JSON: \`${path.relative(options.root, options.jsonPath)}\``,
    "",
  ].join("\n");
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} bytes`;
}

function formatMs(value: number): string {
  return `${Math.round(value * 100) / 100}ms`;
}

function formatNullableMs(value: number | null): string {
  return value === null ? "n/a" : formatMs(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

function tailText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? trimmed.slice(-500) : trimmed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
