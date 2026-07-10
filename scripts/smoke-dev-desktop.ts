import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

type SmokeOptions = {
  jsonPath?: string;
  skipChat: boolean;
  timeoutMs?: number;
};

type ProcessHandle = {
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
};

const DEFAULT_TIMEOUT_MS = 60_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedStops = new WeakSet<ChildProcessWithoutNullStreams>();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const appHome = await mkdtemp(path.join(os.tmpdir(), "openpond-dev-smoke-home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "openpond-dev-smoke-user-data-"));
  const webPort = await freePort();
  const devtoolsPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  let renderer: ProcessHandle | null = null;
  let desktop: ProcessHandle | null = null;
  let cdp: CdpClient | null = null;

  try {
    runSetup("bundle-server", [bunBinary(), "run", "bundle:server"]);
    runSetup("build-desktop", [bunBinary(), "run", "build:desktop"]);

    renderer = startRenderer(webPort);
    await waitForUrl(webUrl, timeoutMs);

    const launchedAt = Date.now();
    desktop = launchDevElectron({
      appHome,
      devtoolsPort,
      userData,
      webUrl,
      webPort,
    });

    const target = await waitForDevtoolsTarget(devtoolsPort, timeoutMs, (candidate) =>
      isMainRendererTarget(candidate, webUrl),
    );
    const devtoolsTargetMs = Date.now() - launchedAt;
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await waitForRendererBridge(cdp, timeoutMs);
    const rendererBridgeMs = Date.now() - launchedAt;
    const rendererState = await waitForRendererReady(cdp, timeoutMs);
    const connection = await evaluateValue<{
      serverUrl: string;
      token: string;
      platform: string;
      hasBrowserBridge: boolean;
    }>(
      cdp,
      `window.openpond.getConnection().then((connection) => ({
        serverUrl: connection.serverUrl,
        token: connection.token,
        platform: connection.platform,
        hasBrowserBridge: typeof window.openpond.browser?.open === "function"
      }))`,
    );
    if (!connection.token) throw new Error("Dev Electron renderer connection did not include a capability token.");

    const healthStartedAt = Date.now();
    const health = await fetchJson<{ ok?: boolean; server?: string }>(`${connection.serverUrl}/health`);
    const serverHealthMs = Date.now() - healthStartedAt;
    if (health.ok !== true || health.server !== "openpond-app-server") {
      throw new Error(`Dev Electron server health failed: ${JSON.stringify(health)}`);
    }

    const [profile, bootstrap, browserStatus] = await Promise.all([
      fetchJsonAuth<{
        mode?: string;
        repoPath?: string | null;
        activeProfile?: string | null;
        git?: { dirty?: boolean; head?: string | null } | null;
        actionCatalog?: Array<{ name?: string | null; id?: string | null }>;
        agents?: Array<{ id?: string | null; enabled?: boolean; path?: string | null }>;
      }>(`${connection.serverUrl}/v1/profile`, connection.token),
      fetchJsonAuth<{
        account?: {
          profile?: { handle?: string | null } | null;
          activeProfile?: { handle?: string | null } | null;
          activeAccount?: { handle?: string | null } | null;
        };
      }>(`${connection.serverUrl}/v1/bootstrap?refreshCodex=1`, connection.token),
      fetchJsonAuth<{
        connected?: boolean;
        pendingCount?: number;
        inFlightCount?: number;
        instanceId?: string | null;
      }>(`${connection.serverUrl}/v1/desktop/browser-control/status`, connection.token),
    ]);
    if (browserStatus.connected !== true) {
      throw new Error(`Dev Electron browser-control worker was not connected: ${JSON.stringify(browserStatus)}`);
    }

    const sharedSurfaceStyles = await verifySharedSurfaceStyles(cdp);
    const renderCommits = await runComposerCommitProof(cdp);

    const chat = options.skipChat
      ? null
      : await runDesktopChatSmoke({
          serverUrl: connection.serverUrl,
          token: connection.token,
          timeoutMs,
        });

    await triggerWindowClose(cdp);
    const exitedAfterClose = desktop ? await waitForExit(desktop.child, 10_000) : false;

    const report = {
      ok: true,
      mode: "dev",
      platform: process.platform,
      renderer: {
        href: rendererState.href,
        title: rendererState.title,
        readyState: rendererState.readyState,
        connectedScreenGone: !rendererState.connecting,
        hasSidebar: rendererState.hasSidebar,
        hasContentShell: rendererState.hasContentShell,
        hasComposer: rendererState.hasComposer,
      },
      bridge: {
        platform: connection.platform,
        hasBrowserBridge: connection.hasBrowserBridge,
        browserControlConnected: browserStatus.connected === true,
      },
      server: {
        url: redactLoopbackUrl(connection.serverUrl),
        health: health.server,
      },
      account: {
        handle:
          bootstrap.account?.profile?.handle ??
          bootstrap.account?.activeProfile?.handle ??
          bootstrap.account?.activeAccount?.handle ??
          null,
      },
      profile: {
        mode: profile.mode ?? null,
        repoPath: profile.repoPath ?? null,
        activeProfile: profile.activeProfile ?? null,
        gitDirty: profile.git?.dirty ?? null,
        gitHead: profile.git?.head?.slice(0, 12) ?? null,
        actions: Array.isArray(profile.actionCatalog)
          ? profile.actionCatalog.map((action) => action.name ?? action.id).filter(Boolean).slice(0, 10)
          : [],
        agents: Array.isArray(profile.agents)
          ? profile.agents.map((agent) => ({
              id: agent.id ?? null,
              enabled: agent.enabled ?? null,
              path: agent.path ?? null,
            })).slice(0, 10)
          : [],
      },
      chat,
      sharedSurfaceStyles,
      renderCommits,
      timings: {
        totalSmokeMs: Date.now() - startedAt,
        devtoolsTargetMs,
        rendererBridgeMs,
        serverHealthMs,
      },
      shutdown: {
        exitedAfterClose,
        exitCode: desktop?.child.exitCode ?? null,
        signalCode: desktop?.child.signalCode ?? null,
      },
    };
    await writeSmokeReport(report, options.jsonPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp?.close();
    await stopProcess(desktop);
    await stopProcess(renderer);
    await Promise.all([
      rm(appHome, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true }),
    ]);
  }
}

async function verifySharedSurfaceStyles(cdp: CdpClient): Promise<{
  insightsButtonWidth: number;
  insightsButtonHeight: number;
  insightsDropdownHidden: boolean;
  teamRowStyled: boolean;
}> {
  const styles = await evaluateValue<{
    buttonWidth: number;
    buttonHeight: number;
    buttonDisplay: string;
    dropdownVisibility: string | null;
    dropdownPointerEvents: string | null;
    teamRowDisplay: string | null;
    teamRowBackgroundColor: string | null;
  }>(
    cdp,
    `(() => {
      const button = document.querySelector(".topbar-insights-button");
      const dropdown = document.querySelector(".topbar-insights-dropdown");
      const existingTeamRow = document.querySelector(".team-sidebar-row");
      const teamRow = existingTeamRow instanceof HTMLElement
        ? existingTeamRow
        : Object.assign(document.createElement("button"), { className: "team-sidebar-row" });
      if (!existingTeamRow) {
        teamRow.style.position = "fixed";
        teamRow.style.visibility = "hidden";
        document.body.append(teamRow);
      }
      if (!(button instanceof HTMLElement)) throw new Error("Insights top-bar button is missing.");
      const buttonStyle = getComputedStyle(button);
      const dropdownStyle = dropdown instanceof HTMLElement ? getComputedStyle(dropdown) : null;
      const teamRowStyle = getComputedStyle(teamRow);
      const result = {
        buttonWidth: button.getBoundingClientRect().width,
        buttonHeight: button.getBoundingClientRect().height,
        buttonDisplay: buttonStyle.display,
        dropdownVisibility: dropdownStyle?.visibility ?? null,
        dropdownPointerEvents: dropdownStyle?.pointerEvents ?? null,
        teamRowDisplay: teamRowStyle.display,
        teamRowBackgroundColor: teamRowStyle.backgroundColor
      };
      if (!existingTeamRow) teamRow.remove();
      return result;
    })()`,
  );
  if (
    !["grid", "inline-grid"].includes(styles.buttonDisplay) ||
    Math.abs(styles.buttonWidth - 28) > 0.1 ||
    Math.abs(styles.buttonHeight - 28) > 0.1
  ) {
    throw new Error(`Insights top-bar styles were not loaded: ${JSON.stringify(styles)}`);
  }
  const insightsDropdownHidden =
    styles.dropdownVisibility === null ||
    (styles.dropdownVisibility === "hidden" && styles.dropdownPointerEvents === "none");
  if (!insightsDropdownHidden) {
    throw new Error(`Insights dropdown was exposed at rest: ${JSON.stringify(styles)}`);
  }
  const teamRowStyled =
    styles.teamRowDisplay === "grid" && styles.teamRowBackgroundColor === "rgba(0, 0, 0, 0)";
  if (!teamRowStyled) {
    throw new Error(`Team sidebar row styles were not loaded: ${JSON.stringify(styles)}`);
  }
  return {
    insightsButtonWidth: styles.buttonWidth,
    insightsButtonHeight: styles.buttonHeight,
    insightsDropdownHidden,
    teamRowStyled,
  };
}

async function runComposerCommitProof(cdp: CdpClient): Promise<{
  composerCommits: number;
  sidebarCommits: number;
  typedCharacters: number;
}> {
  const proofText = "renderer commit boundary proof";
  await waitFor(async () => {
    await evaluateValue<boolean>(cdp, "(window.__OPENPOND_RENDER_COMMITS__?.reset(), true)");
    await Bun.sleep(300);
    const idle = await evaluateValue<Record<string, { commits?: number }>>(
      cdp,
      "window.__OPENPOND_RENDER_COMMITS__?.get() ?? {}",
    );
    return Object.values(idle).every((metric) => (metric.commits ?? 0) === 0);
  }, 5_000, "Renderer did not reach a quiet commit window before the typing proof.");
  await evaluateValue<boolean>(
    cdp,
    `(() => {
      window.__OPENPOND_RENDER_COMMITS__?.reset();
      const input = document.querySelector(".composer-inline-input[role='textbox'], [role='textbox'][contenteditable], textarea");
      if (!(input instanceof HTMLElement)) return false;
      input.focus();
      return true;
    })()`,
  );
  for (const character of proofText) {
    await cdp.send("Input.insertText", { text: character });
  }
  await waitFor(async () => evaluateValue<boolean>(
    cdp,
    `(() => {
      const input = document.querySelector(".composer-inline-input[role='textbox'], [role='textbox'][contenteditable], textarea");
      const value = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
        ? input.value
        : input?.textContent ?? "";
      return value.includes(${JSON.stringify(proofText)});
    })()`,
  ), 5_000, "Composer did not accept commit-budget proof input.");
  const metrics = await evaluateValue<Record<string, { commits?: number }>>(
    cdp,
    "window.__OPENPOND_RENDER_COMMITS__?.get() ?? {}",
  );
  const composerCommits = metrics.composer?.commits ?? 0;
  const sidebarCommits = metrics.sidebar?.commits ?? 0;
  if (composerCommits < 1 || composerCommits > proofText.length + 2) {
    throw new Error(`Composer commit budget failed: ${composerCommits} commits for ${proofText.length} characters.`);
  }
  if (sidebarCommits !== 0) {
    throw new Error(`Composer typing crossed the sidebar render boundary: ${sidebarCommits} commits.`);
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  return { composerCommits, sidebarCommits, typedCharacters: proofText.length };
}

function parseArgs(args: string[]): SmokeOptions {
  const options: SmokeOptions = { skipChat: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log("usage: bun scripts/smoke-dev-desktop.ts [--timeout-ms <ms>] [--json <path>] [--skip-chat]");
      process.exit(0);
    }
    if (arg === "--json") {
      options.jsonPath = args[++index];
      continue;
    }
    if (arg.startsWith("--json=")) {
      options.jsonPath = arg.slice("--json=".length);
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
    if (arg === "--skip-chat") {
      options.skipChat = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return options;
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
  const appArgs = [
    ".",
    `--remote-debugging-port=${input.devtoolsPort}`,
    `--user-data-dir=${input.userData}`,
    "--disable-gpu",
    "--no-sandbox",
  ];
  const electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const wrapped = wrapForDisplay(electron, appArgs);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: path.join(ROOT, "apps", "desktop"),
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      OPENPOND_APP_HOME: input.appHome,
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
    if (expectedStops.has(child)) return;
    process.stdout.write(prefixLines(label, chunk.toString("utf8")));
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr.push(text);
    if (stderr.join("").length > 32_000) stderr.splice(0, stderr.length - 20);
    if (expectedStops.has(child)) return;
    process.stderr.write(prefixLines(label, text));
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
  throw new Error("No DISPLAY is available. Install xvfb and rerun through xvfb-run for Linux dev desktop smoke.");
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
      .catch(() => null);
    if (!Array.isArray(targets)) return null;
    return targets.find((target) => isUsableTarget(target) && predicate(target)) ?? null;
  }, timeoutMs, "Timed out waiting for dev Electron renderer DevTools target.");
}

function isUsableTarget(target: DevtoolsTarget): target is Required<DevtoolsTarget> {
  return (
    target.type === "page" &&
    typeof target.webSocketDebuggerUrl === "string" &&
    typeof target.url === "string" &&
    target.url !== "about:blank" &&
    !target.url.startsWith("devtools://")
  );
}

function isMainRendererTarget(target: Required<DevtoolsTarget>, webUrl: string): boolean {
  return target.url === webUrl || target.url.startsWith(`${webUrl}/`) || target.url.startsWith(`${webUrl}?`);
}

async function waitForRendererBridge(cdp: CdpClient, timeoutMs: number): Promise<void> {
  await waitFor(async () =>
    evaluateValue<boolean>(
      cdp,
      `document.readyState !== "loading" &&
        typeof window.openpond === "object" &&
        typeof window.openpond.getConnection === "function" &&
        typeof window.openpond.browser?.open === "function"`,
    ), timeoutMs, "Timed out waiting for dev Electron preload bridge.");
}

async function waitForRendererReady(
  cdp: CdpClient,
  timeoutMs: number,
): Promise<{
  href: string;
  title: string;
  readyState: string;
  connecting: boolean;
  hasSidebar: boolean;
  hasContentShell: boolean;
  hasComposer: boolean;
}> {
  return waitFor(async () => {
    const state = await evaluateValue<{
      href: string;
      title: string;
      readyState: string;
      connecting: boolean;
      hasSidebar: boolean;
      hasContentShell: boolean;
      hasComposer: boolean;
      errorText: string | null;
    }>(
      cdp,
      `(() => {
        const text = document.body?.innerText || "";
        const errorText = document.querySelector(".error-boundary, [role='alert']")?.textContent || null;
        return {
          href: window.location.href,
          title: document.title,
          readyState: document.readyState,
          connecting: text.includes("Connecting to OpenPond"),
          hasSidebar: Boolean(document.querySelector(".sidebar")),
          hasContentShell: Boolean(document.querySelector(".content-shell")),
          hasComposer: Boolean(document.querySelector(".composer-inline-input[role='textbox'], [role='textbox'][contenteditable], textarea")),
          errorText
        };
      })()`,
    );
    if (state.errorText) throw new Error(`Renderer error screen visible: ${state.errorText.slice(0, 500)}`);
    if (state.readyState === "complete" && !state.connecting && (state.hasSidebar || state.hasContentShell || state.hasComposer)) {
      return state;
    }
    return null;
  }, timeoutMs, "Timed out waiting for dev Electron app shell to render.");
}

async function runDesktopChatSmoke(input: {
  serverUrl: string;
  token: string;
  timeoutMs: number;
}): Promise<{
  sessionId: string;
  turnId: string;
  status: string;
  eventCount: number;
  assistantDeltaSeen: boolean;
}> {
  const session = await fetchJsonAuth<{ id: string }>(`${input.serverUrl}/v1/sessions`, input.token, {
    method: "POST",
    body: {
      provider: "openpond",
      modelRef: { providerId: "openpond", modelId: "openpond-chat" },
      title: `dev-desktop-opchat-smoke-${Date.now()}`,
      hiddenFromDefaultSidebar: true,
      cwd: ROOT,
      metadata: { smoke: "dev-desktop-opchat" },
    },
  });
  const turn = await fetchJsonAuth<{ id: string }>(
    `${input.serverUrl}/v1/sessions/${encodeURIComponent(session.id)}/turns`,
    input.token,
    {
      method: "POST",
      body: {
        prompt: "Reply exactly: dev desktop smoke ok",
        model: "openpond-chat",
        modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        approvalPolicy: "never",
        sandbox: "read-only",
        metadata: { smoke: "dev-desktop-opchat" },
      },
    },
  );

  return waitFor(async () => {
    const bootstrap = await fetchJsonAuth<{ events?: Array<Record<string, unknown>> }>(
      `${input.serverUrl}/v1/bootstrap`,
      input.token,
    );
    const events = Array.isArray(bootstrap.events)
      ? bootstrap.events.filter((event) => event.sessionId === session.id)
      : [];
    const terminal = events.find((event) =>
      event.turnId === turn.id &&
      (event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted")
    );
    if (!terminal) return null;
    if (terminal.name !== "turn.completed") {
      throw new Error(`Dev desktop OpChat turn did not complete: ${JSON.stringify(terminal)}`);
    }
    return {
      sessionId: session.id,
      turnId: turn.id,
      status: String(terminal.name),
      eventCount: events.length,
      assistantDeltaSeen: events.some((event) => event.turnId === turn.id && event.name === "assistant.delta"),
    };
  }, input.timeoutMs, `Timed out waiting for dev desktop OpChat turn ${turn.id}.`);
}

async function triggerWindowClose(cdp: CdpClient): Promise<void> {
  try {
    await evaluateValue<boolean>(cdp, "window.openpond.closeWindow()");
  } catch (error) {
    if (error instanceof Error && /CDP socket closed/i.test(error.message)) return;
    throw error;
  }
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
    await delay(250);
  }
  throw new Error(lastError ? `${message} Last error: ${String(lastError)}` : message);
}

async function evaluateValue<T>(cdp: CdpClient, expression: string): Promise<T> {
  const result = await cdp.send<CdpEvaluation>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed.");
  }
  return result.result?.value as T;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${redactUrl(url)} returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function fetchJsonAuth<T>(
  url: string,
  token: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${redactUrl(url)} returned HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  return await response.json() as T;
}

async function writeSmokeReport(report: Record<string, unknown>, jsonPath?: string): Promise<void> {
  if (!jsonPath) return;
  const outputPath = path.resolve(jsonPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port.");
  return address.port;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopProcess(handle: ProcessHandle | null): Promise<void> {
  if (!handle || handle.child.exitCode !== null) return;
  expectedStops.add(handle.child);
  handle.child.kill("SIGTERM");
  const stopped = await waitForExit(handle.child, 3_000);
  if (!stopped && handle.child.exitCode === null) handle.child.kill("SIGKILL");
}

function redactLoopbackUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}:${url.port || "(default)"}`;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function prefixLines(prefix: string, value: string): string {
  return value
    .split(/(?<=\n)/)
    .map((line) => (line ? `[${prefix}] ${line}` : line))
    .join("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bunBinary(): string {
  return process.versions.bun ? process.execPath : "bun";
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
