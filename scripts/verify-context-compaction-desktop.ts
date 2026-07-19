import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChatProvider, RuntimeEvent, Session } from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { isolatedOpenPondEnvironment } from "./isolated-openpond-environment";

type ProviderProofTarget = "openpond" | "zai";

type Options = {
  provider: "both" | ProviderProofTarget;
  artifactsDir: string;
  keepHome: boolean;
  sourceAppHome: string | null;
  timeoutMs: number;
};

type ProcessHandle = {
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
};

type DevtoolsTarget = {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type CdpEvaluation = {
  result?: {
    type?: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
};

type ServerConnection = {
  serverUrl: string;
  token: string;
};

type ProofSession = {
  id: string;
  provider: ProviderProofTarget;
  modelId: string;
  title: string;
};

type RendererProofSnapshot = {
  sessionTitleVisible: boolean;
  compactionStatusVisible: boolean;
  finalAnswerVisible: boolean;
  providerText: string;
  modelText: string;
  contextStatus: {
    title: string;
    summary: string;
    tokens: string;
    detail: string;
    ariaLabel: string;
  };
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 180_000;
const expectedStops = new WeakSet<ChildProcessWithoutNullStreams>();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.env.OPENPOND_APP_LIVE_DESKTOP_COMPACTION !== "1") {
    console.log("Skipping Desktop compaction proof. Set OPENPOND_APP_LIVE_DESKTOP_COMPACTION=1 to run it.");
    return;
  }

  const targets = proofTargets(options.provider);
  assertProviderEnv(targets);

  const appHome = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-compaction-home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-compaction-user-data-"));
  const artifactsDir = path.resolve(options.artifactsDir);
  const webPort = await freePort();
  const devtoolsPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  let renderer: ProcessHandle | null = null;
  let desktop: ProcessHandle | null = null;
  let cdp: CdpClient | null = null;

  try {
    await mkdir(artifactsDir, { recursive: true });
    await writeCommandReceipt(artifactsDir, options, targets);
    if (targets.includes("zai")) await configureZaiProviderFiles(appHome, options.sourceAppHome);
    const sessions = await seedProofSessions(appHome, targets);

    runSetup("bundle-server", [bunBinary(), "run", "bundle:server"]);
    runSetup("build-desktop", [bunBinary(), "run", "build:desktop"]);

    renderer = startRenderer(webPort);
    await waitForUrl(webUrl, options.timeoutMs);
    desktop = launchDevElectron({ appHome, userData, webPort, webUrl, devtoolsPort });

    const target = await waitForDevtoolsTarget(devtoolsPort, options.timeoutMs, (candidate) =>
      candidate.type === "page" && Boolean(candidate.webSocketDebuggerUrl) && candidate.url.startsWith(webUrl),
    );
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await waitForRendererBridge(cdp, options.timeoutMs);
    const connection = await rendererConnection(cdp);
    if (!connection.token) throw new Error("Desktop renderer connection did not expose a capability token.");

    const proofs = [];
    for (const session of sessions) {
      proofs.push(await runProviderProof({
        artifactsDir,
        cdp,
        connection,
        session,
        timeoutMs: options.timeoutMs,
      }));
    }

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      appHome: options.keepHome ? appHome : null,
      artifactsDir,
      proofs,
    };
    const reportPath = path.join(artifactsDir, "desktop-compaction-proof.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp?.close();
    await stopProcess(desktop);
    await stopProcess(renderer);
    await rm(userData, { recursive: true, force: true });
    if (!options.keepHome) await rm(appHome, { recursive: true, force: true });
  }
}

async function runProviderProof(input: {
  artifactsDir: string;
  cdp: CdpClient;
  connection: ServerConnection;
  session: ProofSession;
  timeoutMs: number;
}) {
  await selectSessionInRenderer(input.cdp, input.session.id, input.timeoutMs);

  const compacted = await fetchJsonAuth<{ summaryEventId: string | null }>(
    `${input.connection.serverUrl}/v1/sessions/${encodeURIComponent(input.session.id)}/compact`,
    input.connection.token,
    {
      method: "POST",
      body: { reason: "manual", model: input.session.modelId },
    },
  );
  if (!compacted.summaryEventId) throw new Error(`${input.session.provider} compaction did not return a summary event id.`);

  const prompt = `Use the compacted context and reply exactly: ${input.session.provider} desktop compaction proof ok`;
  const beforeFollowUpEventIds = new Set((await sessionEvents(input.connection, input.session.id)).map((event) => event.id));
  await submitPromptThroughRenderer(input.cdp, prompt);
  const turnStarted = await waitFor(async () => {
    const events = await sessionEvents(input.connection, input.session.id);
    return events.find((event) =>
      !beforeFollowUpEventIds.has(event.id) &&
      event.name === "turn.started" &&
      promptFromTurnStarted(event) === prompt &&
      Boolean(event.turnId)
    ) ?? null;
  }, input.timeoutMs, `Timed out waiting for ${input.session.provider} UI-submitted proof turn.`);
  const turnId = turnStarted.turnId;
  if (!turnId) throw new Error(`${input.session.provider} UI-submitted proof turn had no turn id.`);

  const terminal = await waitFor(async () => {
    const events = await sessionEvents(input.connection, input.session.id);
    const terminalEvent = events.find((event) =>
      event.turnId === turnId &&
      (event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted")
    );
    if (!terminalEvent) return null;
    if (terminalEvent.name !== "turn.completed") {
      throw new Error(`${input.session.provider} proof turn did not complete: ${JSON.stringify(terminalEvent)}`);
    }
    return terminalEvent;
  }, input.timeoutMs, `Timed out waiting for ${input.session.provider} proof turn.`);

  await waitFor(async () => {
    const text = await rendererText(input.cdp);
    return text.includes("Compacted context") && text.includes(`${input.session.provider} desktop compaction proof ok`);
  }, input.timeoutMs, `Timed out waiting for ${input.session.provider} proof text in Desktop renderer.`);

  const events = await sessionEvents(input.connection, input.session.id);
  const usage = await fetchJsonAuth<{ records?: Array<Record<string, unknown>> }>(
    `${input.connection.serverUrl}/v1/usage/records?range=all&limit=100`,
    input.connection.token,
  );
  const sessionUsage = (usage.records ?? []).filter((record) => record.sessionId === input.session.id);
  await revealContextStatusTooltip(input.cdp);
  const rendererProof = await rendererProofSnapshot(input.cdp, input.session);
  assertRendererProof(input.session, rendererProof);
  const screenshotPath = path.join(input.artifactsDir, `${input.session.provider}-desktop-compaction.png`);
  await captureScreenshot(input.cdp, screenshotPath);
  const screenshotBytes = (await stat(screenshotPath)).size;
  if (screenshotBytes <= 0) throw new Error(`${input.session.provider} screenshot artifact was empty.`);

  const started = events.find((event) => event.name === "session.compaction.started");
  const completed = events.find((event) => event.name === "session.compaction.completed");
  if (!started || !completed) throw new Error(`${input.session.provider} proof did not emit compaction lifecycle events.`);
  const contextCompactionUsage = sessionUsage.filter((record) => record.requestKind === "context_compaction");
  const followUpUsage = sessionUsage.filter((record) => record.requestKind === "chat_turn");
  if (contextCompactionUsage.length === 0) {
    throw new Error(`${input.session.provider} proof did not record context_compaction usage.`);
  }
  if (followUpUsage.length === 0) {
    throw new Error(`${input.session.provider} proof did not record follow-up chat_turn usage.`);
  }

  return {
    provider: input.session.provider,
    model: input.session.modelId,
    sessionId: input.session.id,
    title: input.session.title,
    compactionStartedEventId: started.id,
    compactionCompletedEventId: completed.id,
    summaryEventId: compacted.summaryEventId,
    followUpTurnId: turnId,
    followUpTerminalEventId: terminal.id,
    screenshotPath,
    screenshotBytes,
    rendererProof,
    proofNotes: proofNotes(input.session),
    usageIds: sessionUsage.map((record) => record.id).filter(Boolean),
    contextCompactionUsageIds: contextCompactionUsage.map((record) => record.id).filter(Boolean),
    followUpUsageIds: followUpUsage.map((record) => record.id).filter(Boolean),
  };
}

async function seedProofSessions(appHome: string, targets: ProviderProofTarget[]): Promise<ProofSession[]> {
  const store = new SqliteStore(appHome);
  const now = new Date().toISOString();
  const sessions = targets.map((provider): ProofSession => ({
    id: `desktop_compaction_${provider}_${Date.now()}`,
    provider,
    modelId: provider === "openpond" ? "openpond-chat" : "glm-5.2",
    title: `Desktop compaction proof - ${provider === "openpond" ? "OpenPond Chat" : "Z.ai GLM"}`,
  }));

  await store.mutate((data) => {
    for (const proof of sessions) {
      data.sessions.push(sessionForProof(proof, now));
      data.events.push(...seedEventsForProof(proof.id, now));
    }
  });
  await store.close();
  return sessions;
}

function sessionForProof(proof: ProofSession, timestamp: string): Session {
  return {
    id: proof.id,
    provider: proof.provider,
    modelRef: providerModelRef(proof),
    title: proof.title,
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
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function seedEventsForProof(sessionId: string, timestamp: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < 4; index += 1) {
    const turnId = `${sessionId}_seed_turn_${index}`;
    events.push({
      id: `${turnId}_started`,
      sessionId,
      turnId,
      name: "turn.started",
      timestamp,
      source: "server",
      args: {
        prompt: [
          `Seeded compaction proof turn ${index}.`,
          "Remember the target file apps/server/src/openpond/context-compaction/index.ts.",
          "The final answer must preserve the active requirement: visible Desktop compaction proof.",
          "Repeat filler context to force summary work.",
          "context ".repeat(60),
        ].join(" "),
      },
    });
    events.push({
      id: `${turnId}_assistant`,
      sessionId,
      turnId,
      name: "assistant.delta",
      timestamp,
      source: "provider",
      output: [
        `Acknowledged seeded compaction proof turn ${index}.`,
        "Relevant validation: pnpm exec vitest run tests/context-compaction.test.ts tests/manual-compaction-usage.test.ts.",
        "The visible transcript must keep compaction rows while provider replay uses the compacted summary.",
        "assistant-context ".repeat(45),
      ].join(" "),
    });
  }
  events.push(contextUsageSeedEvent(sessionId, timestamp));
  return events;
}

function contextUsageSeedEvent(sessionId: string, timestamp: string): RuntimeEvent {
  const provider = sessionId.includes("_zai_") ? "zai" : "openpond";
  const model = provider === "zai" ? "glm-5.2" : "openpond-chat";
  const maxContextTokens = 128_000;
  const usedTokens = provider === "zai" ? 43_520 : 38_400;
  return {
    id: `${sessionId}_context_usage_seed`,
    sessionId,
    name: "session.context.updated",
    timestamp,
    source: "server",
    status: "completed",
    output: "Seeded visible Desktop context-window proof status.",
    data: {
      provider,
      model,
      usedTokens,
      maxContextTokens,
      usableContextTokens: 120_000,
      percentFull: Math.round((usedTokens / maxContextTokens) * 100),
      source: "heuristic",
      updatedAtEventId: `${sessionId}_seed_turn_3_assistant`,
    },
  };
}

function providerModelRef(session: ProofSession): { providerId: ChatProvider; modelId: string } {
  return {
    providerId: session.provider,
    modelId: session.modelId,
  };
}

async function configureZaiProviderFiles(appHome: string, sourceAppHome: string | null): Promise<void> {
  if (sourceAppHome) {
    await copyProviderCredentialFiles({
      sourceAppHome: path.resolve(sourceAppHome),
      appHome,
      providerId: "zai",
    });
    await ensureZaiModelMetadata(appHome);
    return;
  }
  await writeZaiEnvProviderFiles(appHome);
}

async function copyProviderCredentialFiles(input: {
  sourceAppHome: string;
  appHome: string;
  providerId: string;
}): Promise<void> {
  await mkdir(input.appHome, { recursive: true });
  const providersPath = path.join(input.sourceAppHome, "providers.json");
  const secretsPath = path.join(input.sourceAppHome, "provider-secrets.json");
  const keyPath = path.join(input.sourceAppHome, "provider-secrets.key");
  const providers = JSON.parse(await readFile(providersPath, "utf8")) as Record<string, unknown>;
  const secrets = JSON.parse(await readFile(secretsPath, "utf8")) as Record<string, unknown>;
  const providerRecord = recordValue(recordValue(providers, "providers"), input.providerId);
  const secretRecord = recordValue(recordValue(secrets, "providers"), input.providerId);
  if (!providerRecord) throw new Error(`Source app home has no ${input.providerId} provider config.`);
  if (!secretRecord) throw new Error(`Source app home has no ${input.providerId} provider credential.`);
  await copyFile(providersPath, path.join(input.appHome, "providers.json"));
  await copyFile(secretsPath, path.join(input.appHome, "provider-secrets.json"));
  if (secretRecord.source === "local_secret" || secretRecord.source === "chatgpt_subscription") {
    await copyFile(keyPath, path.join(input.appHome, "provider-secrets.key"));
  }
}

async function ensureZaiModelMetadata(appHome: string): Promise<void> {
  const file = path.join(appHome, "providers.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const providers = recordValue(raw, "providers") ?? {};
  const currentProvider = recordValue(providers, "zai");
  if (!currentProvider) throw new Error("Z.ai source provider config was not copied.");
  const modelCaches = recordValue(raw, "modelCaches") ?? {};
  const currentCache = recordValue(modelCaches, "zai") ?? {};
  const currentModels = Array.isArray(currentCache.models) ? currentCache.models : [];
  const hasProofModel = currentModels.some((model) =>
    model && typeof model === "object" && !Array.isArray(model) &&
      (model as Record<string, unknown>).id === "glm-5.2"
  );
  const models = hasProofModel
    ? currentModels
    : [
        {
          id: "glm-5.2",
          providerId: "zai",
          displayName: "GLM 5.2",
          contextWindow: 128000,
          outputLimit: 8192,
          source: "manual",
        },
        ...currentModels,
      ];
  const next = {
    ...raw,
    providers: {
      ...providers,
      zai: {
        ...currentProvider,
        enabled: true,
      },
    },
    modelCaches: {
      ...modelCaches,
      zai: {
        ...currentCache,
        providerId: "zai",
        models,
        fetchedAt: typeof currentCache.fetchedAt === "string" ? currentCache.fetchedAt : new Date().toISOString(),
        lastError: null,
        source: typeof currentCache.source === "string" ? currentCache.source : "manual",
      },
    },
  };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}

async function writeZaiEnvProviderFiles(appHome: string): Promise<void> {
  const key = process.env.OPENPOND_APP_LIVE_ZAI_API_KEY ?? process.env.ZAI_API_KEY;
  if (!key) throw new Error("Z.ai proof requires OPENPOND_APP_LIVE_ZAI_API_KEY or ZAI_API_KEY.");
  process.env.OPENPOND_APP_LIVE_ZAI_API_KEY = key;
  await writeFile(
    path.join(appHome, "providers.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        zai: {
          enabled: true,
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          defaultModel: "glm-5.2",
          modelOverrides: [],
          updatedAt: new Date().toISOString(),
        },
      },
      modelCaches: {
        zai: {
          providerId: "zai",
          models: [
            {
              id: "glm-5.2",
              providerId: "zai",
              displayName: "GLM 5.2",
              contextWindow: 128000,
              outputLimit: 8192,
              source: "manual",
            },
          ],
          fetchedAt: new Date().toISOString(),
          lastError: null,
          source: "manual",
        },
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(appHome, "provider-secrets.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        zai: {
          source: "env",
          envVar: "OPENPOND_APP_LIVE_ZAI_API_KEY",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }, null, 2)}\n`,
  );
}

function recordValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : null;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    provider: "both",
    artifactsDir: path.join(
      ROOT,
      "docs",
      "working-docs",
      "server",
      "proofs",
      `${new Date().toISOString().slice(0, 10)}-context-compaction-desktop`,
    ),
    keepHome: false,
    sourceAppHome: process.env.OPENPOND_APP_LIVE_SOURCE_HOME?.trim() || null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: pnpm run verify:desktop:compaction -- [--provider openpond|zai|both] [--artifacts-dir <path>] [--source-app-home <path>] [--timeout-ms <ms>] [--keep-home]",
      );
      process.exit(0);
    }
    if (arg === "--provider") {
      options.provider = parseProvider(args[++index]);
      continue;
    }
    if (arg.startsWith("--provider=")) {
      options.provider = parseProvider(arg.slice("--provider=".length));
      continue;
    }
    if (arg === "--artifacts-dir") {
      options.artifactsDir = args[++index] ?? options.artifactsDir;
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      options.artifactsDir = arg.slice("--artifacts-dir=".length);
      continue;
    }
    if (arg === "--source-app-home") {
      options.sourceAppHome = args[++index] ?? options.sourceAppHome;
      continue;
    }
    if (arg.startsWith("--source-app-home=")) {
      options.sourceAppHome = arg.slice("--source-app-home=".length);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(args[++index]);
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
      continue;
    }
    if (arg === "--keep-home") {
      options.keepHome = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return options;
}

function parseProvider(value: string | undefined): Options["provider"] {
  if (value === "openpond" || value === "zai" || value === "both") return value;
  throw new Error("--provider must be openpond, zai, or both.");
}

function proofTargets(provider: Options["provider"]): ProviderProofTarget[] {
  if (provider === "both") return ["openpond", "zai"];
  return [provider];
}

function assertProviderEnv(targets: ProviderProofTarget[]): void {
  if (targets.includes("openpond") && process.env.OPENPOND_APP_LIVE_OPENPOND !== "1") {
    throw new Error("OpenPond proof requires OPENPOND_APP_LIVE_OPENPOND=1.");
  }
  if (targets.includes("zai") && process.env.OPENPOND_APP_LIVE_ZAI !== "1") {
    throw new Error("Z.ai proof requires OPENPOND_APP_LIVE_ZAI=1.");
  }
}

function runSetup(label: string, command: [string, ...string[]]): void {
  console.log(`Running ${label}: ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${label} failed with code ${result.status ?? "unknown"}`);
}

function startRenderer(webPort: number): ProcessHandle {
  const child = spawn(bunBinary(), ["run", "--cwd", "apps/web", "dev"], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENPOND_WEB_PORT: String(webPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trackProcess("renderer", child);
}

function launchDevElectron(input: {
  appHome: string;
  devtoolsPort: number;
  userData: string;
  webUrl: string;
  webPort: number;
}): ProcessHandle {
  const electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const wrapped = wrapForDisplay(electron, [
    ".",
    `--remote-debugging-port=${input.devtoolsPort}`,
    `--user-data-dir=${input.userData}`,
    "--disable-gpu",
    "--no-sandbox",
  ]);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: path.join(ROOT, "apps", "desktop"),
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      ...isolatedOpenPondEnvironment(input.appHome),
      OPENPOND_SERVER_PORT: "0",
      OPENPOND_WEB_PORT: String(input.webPort),
      OPENPOND_WEB_URL: input.webUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trackProcess("desktop", child);
}

function trackProcess(label: string, child: ChildProcessWithoutNullStreams): ProcessHandle {
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => {
    if (!expectedStops.has(child)) process.stdout.write(prefixLines(label, chunk.toString("utf8")));
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr.push(text);
    if (stderr.join("").length > 32_000) stderr.splice(0, stderr.length - 20);
    if (!expectedStops.has(child)) process.stderr.write(prefixLines(label, text));
  });
  child.on("exit", (code, signal) => {
    if (code === 0 || signal || expectedStops.has(child)) return;
    console.error(`${label} exited early with code ${code}. stderr:\n${stderr.join("")}`);
  });
  return { child, stderr };
}

function wrapForDisplay(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "linux" || process.env.DISPLAY) return { command, args };
  if (commandExists("xvfb-run")) return { command: "xvfb-run", args: ["-a", command, ...args] };
  throw new Error("No DISPLAY is available. Install xvfb and rerun through xvfb-run for Linux Desktop compaction proof.");
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return pathValue.split(path.delimiter).some((dir) =>
    extensions.some((extension) => existsSync(path.join(dir, `${command}${extension}`))),
  );
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, timeoutMs, `Timed out waiting for ${url}`);
}

async function waitForDevtoolsTarget(
  port: number,
  timeoutMs: number,
  predicate: (candidate: Required<DevtoolsTarget>) => boolean,
): Promise<Required<DevtoolsTarget>> {
  return waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null) as DevtoolsTarget[] | null;
    for (const target of targets ?? []) {
      if (!target.webSocketDebuggerUrl || !target.url || !target.type) continue;
      const candidate = { ...target, title: target.title ?? "" } as Required<DevtoolsTarget>;
      if (predicate(candidate)) return candidate;
    }
    return null;
  }, timeoutMs, "Timed out waiting for Desktop renderer DevTools target.");
}

async function waitForRendererBridge(cdp: CdpClient, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const ready = await evaluateValue<boolean>(
      cdp,
      `Boolean(window.openpond && typeof window.openpond.getConnection === "function")`,
    );
    return ready;
  }, timeoutMs, "Timed out waiting for Desktop preload bridge.");
}

async function rendererConnection(cdp: CdpClient): Promise<ServerConnection> {
  return evaluateValue<ServerConnection>(
    cdp,
    `window.openpond.getConnection().then((connection) => ({
      serverUrl: connection.serverUrl,
      token: connection.token
    }))`,
  );
}

async function selectSessionInRenderer(cdp: CdpClient, sessionId: string, timeoutMs: number): Promise<void> {
  const selector = JSON.stringify(`[data-session-id="${sessionId}"]`);
  await waitFor(async () => {
    return evaluateValue<boolean>(
      cdp,
      `(() => {
        const row = document.querySelector(${selector});
        if (!row) return false;
        row.scrollIntoView({ block: "center" });
        if (!row.classList.contains("selected")) row.click();
        return row.classList.contains("selected");
      })()`,
    );
  }, timeoutMs, `Timed out waiting for Desktop session row ${sessionId}.`);
}

async function revealContextStatusTooltip(cdp: CdpClient): Promise<void> {
  const focused = await evaluateValue<boolean>(
    cdp,
    `(() => {
      const status = document.querySelector('.context-status-shell .composer-status');
      if (!(status instanceof HTMLElement)) return false;
      status.focus();
      return document.activeElement === status;
    })()`,
  );
  if (!focused) throw new Error("Desktop context-window status control was not available.");
  await delay(150);
}

async function rendererProofSnapshot(cdp: CdpClient, session: ProofSession): Promise<RendererProofSnapshot> {
  return evaluateValue<RendererProofSnapshot>(
    cdp,
    `(() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const text = document.body.innerText || '';
      const providerButton = document.querySelector('button[aria-label="Provider"]');
      const modelButton = document.querySelector('button[aria-label="Model"]');
      const contextShell = document.querySelector('.context-status-shell');
      const contextStatus = contextShell?.querySelector('.composer-status');
      const tooltip = contextShell?.querySelector('.context-status-tooltip');
      const tooltipMain = Array.from(tooltip?.querySelectorAll('.context-status-tooltip-main span') || []);
      return {
        sessionTitleVisible: text.includes(${JSON.stringify(session.title)}),
        compactionStatusVisible: text.includes('Compacted context'),
        finalAnswerVisible: text.includes(${JSON.stringify(`${session.provider} desktop compaction proof ok`)}),
        providerText: clean(providerButton?.textContent),
        modelText: clean(modelButton?.textContent),
        contextStatus: {
          title: clean(tooltip?.querySelector('.context-status-tooltip-title')?.textContent),
          summary: clean(tooltipMain[0]?.textContent),
          tokens: clean(tooltipMain[1]?.textContent),
          detail: clean(tooltip?.querySelector('.context-status-tooltip-detail')?.textContent),
          ariaLabel: clean(contextStatus?.getAttribute('aria-label')),
        },
      };
    })()`,
  );
}

function assertRendererProof(session: ProofSession, proof: RendererProofSnapshot): void {
  const providerText = proof.providerText.toLowerCase();
  const modelText = proof.modelText.toLowerCase();
  const expectedAnswer = `${session.provider} desktop compaction proof ok`;
  const required = {
    sessionTitleVisible: proof.sessionTitleVisible,
    compactionStatusVisible: proof.compactionStatusVisible,
    finalAnswerVisible: proof.finalAnswerVisible,
    providerVisible:
      session.provider === "openpond"
        ? providerText.includes("openpond")
        : providerText.includes("zai") || providerText.includes("z.ai"),
    modelVisible:
      session.provider === "openpond"
        ? modelText.includes("openpond")
        : modelText.includes("glm") || modelText.includes("zai/glm-5.2"),
    contextWindowVisible: proof.contextStatus.title === "Context window",
    contextWindowMeasured:
      proof.contextStatus.summary.includes("% full") &&
      proof.contextStatus.tokens.includes("tokens used") &&
      proof.contextStatus.ariaLabel.includes("Context window:"),
  };
  if (Object.values(required).every(Boolean)) return;
  throw new Error(
    `${session.provider} proof did not leave required visible Desktop text for "${expectedAnswer}": ${
      JSON.stringify({ required, proof })
    }`,
  );
}

async function submitPromptThroughRenderer(cdp: CdpClient, prompt: string): Promise<void> {
  const focused = await evaluateValue<boolean>(
    cdp,
    `(() => {
      const input = document.querySelector('.composer-inline-input[role="textbox"]');
      if (!(input instanceof HTMLElement)) return false;
      input.focus();
      input.textContent = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return true;
    })()`,
  );
  if (!focused) throw new Error("Desktop composer input was not available.");
  await cdp.send("Input.insertText", { text: prompt });
  await delay(100);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function rendererText(cdp: CdpClient): Promise<string> {
  return evaluateValue<string>(cdp, "document.body.innerText || ''");
}

async function sessionEvents(connection: ServerConnection, sessionId: string): Promise<RuntimeEvent[]> {
  const bootstrap = await fetchJsonAuth<{ events?: RuntimeEvent[] }>(`${connection.serverUrl}/v1/bootstrap`, connection.token);
  return (bootstrap.events ?? []).filter((event) => event.sessionId === sessionId);
}

async function captureScreenshot(cdp: CdpClient, outputPath: string): Promise<void> {
  const result = await cdp.send<{ data?: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  if (!result.data) throw new Error("Desktop screenshot did not return image data.");
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function fetchJsonAuth<T>(
  url: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function writeCommandReceipt(
  artifactsDir: string,
  options: Options,
  targets: ProviderProofTarget[],
): Promise<void> {
  await writeFile(
    path.join(artifactsDir, "desktop-compaction-proof-command.txt"),
    [
      `generatedAt=${new Date().toISOString()}`,
      `cwd=${ROOT}`,
      `command=pnpm run verify:desktop:compaction --provider ${options.provider} --artifacts-dir ${options.artifactsDir}`,
      `targets=${targets.join(",")}`,
      `requires=OPENPOND_APP_LIVE_DESKTOP_COMPACTION=1`,
      targets.includes("openpond") ? "requires=OPENPOND_APP_LIVE_OPENPOND=1" : null,
      targets.includes("zai") ? "requires=OPENPOND_APP_LIVE_ZAI=1" : null,
      targets.includes("zai") && options.sourceAppHome
        ? `sourceAppHome=${path.resolve(options.sourceAppHome)}`
        : null,
      targets.includes("zai") && !options.sourceAppHome
        ? "requires=OPENPOND_APP_LIVE_ZAI_API_KEY or ZAI_API_KEY"
        : null,
      "notes=Follow-up prompt is submitted through the rendered Desktop composer. Manual compaction currently uses the server compact endpoint because no visible compact control exists yet.",
      targets.includes("zai")
        ? "zaiContextWindowOverride=Disposable app home seeds glm-5.2 contextWindow=128000 for proof metadata."
        : null,
      "",
    ].filter(Boolean).join("\n"),
  );
}

function promptFromTurnStarted(event: RuntimeEvent): string | null {
  const args = event.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const prompt = (args as { prompt?: unknown }).prompt;
  return typeof prompt === "string" ? prompt : null;
}

function proofNotes(session: ProofSession): Record<string, unknown> {
  return {
    providerModel: `${session.provider}/${session.modelId}`,
    desktopSurface: "Rendered Desktop UI selected the proof session and submitted the follow-up prompt through the composer.",
    compactTrigger: "Manual compact endpoint is used because the app has no visible manual compact control yet.",
    contextWindowOverride:
      session.provider === "zai"
        ? "Disposable app home seeds glm-5.2 contextWindow=128000 for trusted Z.ai BYOK compaction metadata."
        : null,
  };
}

async function evaluateValue<T>(cdp: CdpClient, expression: string): Promise<T> {
  const evaluation = await cdp.send<CdpEvaluation>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description ??
      evaluation.exceptionDetails.text ??
      "Renderer evaluation failed.",
    );
  }
  return evaluation.result?.value as T;
}

async function waitFor<T>(
  probe: () => Promise<T | null | false>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(lastError ? `${message} Last error: ${String(lastError)}` : message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a free port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function stopProcess(handle: ProcessHandle | null): Promise<void> {
  if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  expectedStops.add(handle.child);
  handle.child.kill("SIGTERM");
  await waitForExit(handle.child, 5_000).catch(() => {
    handle.child.kill("SIGKILL");
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function prefixLines(label: string, text: string): string {
  return text.split(/(?<=\n)/).map((line) => (line ? `[${label}] ${line}` : line)).join("");
}

function bunBinary(): string {
  return process.execPath;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : event.data.toString();
      const message = JSON.parse(data) as CdpResponse;
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed."));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed."));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed to open.")), { once: true });
    });
    return new CdpClient(socket);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close(): void {
    this.socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
