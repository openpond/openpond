import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readdirSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type DevtoolsTarget = {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

type LaunchTarget = {
  command: string;
  args: string[];
  appPath: string;
};

type SmokeOptions = {
  appPath?: string;
  timeoutMs?: number;
  jsonPath?: string;
};

type BrowserInputProof = {
  snapshotTargetCount: number;
  snapshotIdPresent: boolean;
  screenshotAvailable: boolean;
  moveOk: boolean;
  clickOk: boolean;
  typeOk: boolean;
  keyOk: boolean;
  clicked: boolean;
  submitted: boolean;
  typedLength: number;
  cursorOverlay: boolean;
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

const DEFAULT_TIMEOUT_MS = 45_000;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const appHome = await mkdtemp(path.join(os.tmpdir(), "openpond-packaged-smoke-home-"));
  const userData = await mkdtemp(path.join(os.tmpdir(), "openpond-packaged-smoke-user-data-"));
  const fixture = await startFixtureServer();
  const devtoolsPort = await freePort();
  const launchTarget = await resolveLaunchTarget(options.appPath);
  const launchedAt = Date.now();
  const child = launchPackagedApp(launchTarget, {
    appHome,
    userData,
    devtoolsPort,
  });
  let cdp: CdpClient | null = null;
  try {
    const target = await waitForDevtoolsTarget(devtoolsPort, timeoutMs);
    const devtoolsTargetMs = Date.now() - launchedAt;
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl!);
    await waitForRendererBridge(cdp, timeoutMs);
    const rendererBridgeMs = Date.now() - launchedAt;
    const renderer = await evaluateValue<{
      href: string;
      title: string;
      readyState: string;
      timing: {
        domContentLoadedMs: number | null;
        loadEventMs: number | null;
      };
    }>(
      cdp,
      `(() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        const timing = navigation && "domContentLoadedEventEnd" in navigation
          ? {
              domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
              loadEventMs: Math.round(navigation.loadEventEnd)
            }
          : { domContentLoadedMs: null, loadEventMs: null };
        return {
          href: window.location.href,
          title: document.title,
          readyState: document.readyState,
          timing
        };
      })()`,
    );
    const connection = await evaluateValue<{
      serverUrl: string;
      platform: string;
      hasToken: boolean;
    }>(
      cdp,
      `window.openpond.getConnection().then((connection) => ({
        serverUrl: connection.serverUrl,
        platform: connection.platform,
        hasToken: typeof connection.token === "string" && connection.token.length > 0
      }))`,
    );
    if (!connection.hasToken) throw new Error("Packaged renderer connection did not include a capability token.");
    const healthStartedAt = Date.now();
    const health = await fetchJson<{ ok?: boolean; server?: string }>(`${connection.serverUrl}/health`);
    const healthMs = Date.now() - healthStartedAt;
    if (health.ok !== true || health.server !== "openpond-app-server") {
      throw new Error(`Packaged server health failed: ${JSON.stringify(health)}`);
    }
    const firstChatInput = await measureFirstChatInputLatency(cdp);

    const conversationId = `packaged-smoke-${Date.now()}`;
    const browserOpen = await evaluateValue<{ ok: boolean; error?: string }>(
      cdp,
      `window.openpond.browser.open({
        conversationId: ${JSON.stringify(conversationId)},
        url: ${JSON.stringify(fixture.url)}
      })`,
    );
    if (!browserOpen.ok) throw new Error(browserOpen.error ?? "Browser sidebar open failed.");
    const browserBounds = await evaluateValue<{ ok: boolean; error?: string }>(
      cdp,
      `window.openpond.browser.setBounds({
        conversationId: ${JSON.stringify(conversationId)},
        bounds: { x: 20, y: 80, width: 640, height: 420 }
      })`,
    );
    if (!browserBounds.ok) throw new Error(browserBounds.error ?? "Browser sidebar bounds failed.");
    const browserState = await waitForBrowserState(cdp, conversationId, fixture.url, timeoutMs);
    const fixtureTarget = await waitForDevtoolsTargetUrl(devtoolsPort, fixture.url, timeoutMs);
    const fixtureCdp = await CdpClient.connect(fixtureTarget.webSocketDebuggerUrl);
    let browserInputProof: BrowserInputProof;
    try {
      browserInputProof = await runBrowserInputProof(cdp, fixtureCdp, conversationId, timeoutMs);
    } finally {
      fixtureCdp.close();
    }
    const browserClose = await evaluateValue<{ ok: boolean; error?: string }>(
      cdp,
      `window.openpond.browser.close({ conversationId: ${JSON.stringify(conversationId)} })`,
    );
    if (!browserClose.ok) throw new Error(browserClose.error ?? "Browser sidebar close failed.");
    const browserDiagnostics = await waitForBrowserDetached(cdp, timeoutMs);
    await triggerWindowClose(cdp);
    const exit = await waitForExit(child, process.platform === "darwin" ? 5_000 : timeoutMs);
    if (!exit && process.platform === "darwin") {
      child.kill("SIGTERM");
      await waitForExit(child, 10_000);
    }
    if (process.platform !== "darwin" && !exit) {
      throw new Error("Packaged app did not exit after closing its main window.");
    }

    const report = {
      ok: true,
      appPath: launchTarget.appPath,
      platform: process.platform,
      renderer: {
        href: renderer.href,
        title: renderer.title,
        readyState: renderer.readyState,
      },
      timings: {
        totalSmokeMs: Date.now() - startedAt,
        desktopStartupMs: rendererBridgeMs,
        initialRendererReadyMs: renderer.timing.domContentLoadedMs ?? rendererBridgeMs,
        devtoolsTargetMs,
        rendererBridgeMs,
        rendererDomContentLoadedMs: renderer.timing.domContentLoadedMs,
        rendererLoadEventMs: renderer.timing.loadEventMs,
        serverHealthMs: healthMs,
        firstChatInputLatencyMs: firstChatInput.durationMs,
      },
      server: {
        url: redactLoopbackUrl(connection.serverUrl),
        health: health.server,
      },
      browser: {
        activeTabId: browserState.activeTabId,
        tabCount: browserState.tabs.length,
        inputProof: browserInputProof,
        attachedAfterClose: browserDiagnostics.attachedRuntimeCount,
        closeProof: browserDiagnostics.proof,
      },
      shutdown: {
        exitedAfterClose: Boolean(exit),
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      },
    };
    await writeSmokeReport(report, options.jsonPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 3_000);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fixture.server.close();
    await Promise.all([
      rm(appHome, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true }),
    ]);
  }
}

async function writeSmokeReport(report: Record<string, unknown>, jsonPath?: string): Promise<void> {
  if (!jsonPath) return;
  const outputPath = path.resolve(jsonPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function parseArgs(args: string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log("usage: bun scripts/smoke-packaged-desktop.ts [--app <path>] [--timeout-ms <ms>] [--json <path>]");
      process.exit(0);
    }
    if (arg === "--app") {
      options.appPath = args[++index];
      continue;
    }
    if (arg.startsWith("--app=")) {
      options.appPath = arg.slice("--app=".length);
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
    if (arg === "--json") {
      options.jsonPath = args[++index];
      continue;
    }
    if (arg.startsWith("--json=")) {
      options.jsonPath = arg.slice("--json=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return options;
}

async function resolveLaunchTarget(appPath?: string): Promise<LaunchTarget> {
  const explicit = appPath ?? process.env.OPENPOND_DESKTOP_APP_PATH;
  if (explicit) return launchTargetForPath(path.resolve(explicit));
  const candidates = packagedAppCandidates();
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return launchTargetForPath(candidate);
    } catch {
      // Try the next packaging output.
    }
  }
  throw new Error(
    `No packaged desktop app was found. Run the platform package script first, or pass --app. Checked: ${candidates.join(", ")}`,
  );
}

export function packagedAppCandidates(
  root = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") {
    return [
      path.join(root, "release", "mac", "openpond.app"),
      path.join(root, "release", "mac", "openpond nightly.app"),
      path.join(root, "release", "mac", "openpond-app.app"),
      path.join(root, "release", "mac", "openpond-app-nightly.app"),
      path.join(root, "release", "mac-arm64", "openpond.app"),
      path.join(root, "release", "mac-arm64", "openpond nightly.app"),
      path.join(root, "release", "mac-arm64", "openpond-app.app"),
      path.join(root, "release", "mac-arm64", "openpond-app-nightly.app"),
      path.join(root, "release", "mac-universal", "openpond.app"),
      path.join(root, "release", "mac-universal", "openpond nightly.app"),
      path.join(root, "release", "mac-universal", "openpond-app.app"),
      path.join(root, "release", "mac-universal", "openpond-app-nightly.app"),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(root, "release", "win-unpacked", "openpond.exe"),
      path.join(root, "release", "win-unpacked", "openpond nightly.exe"),
      path.join(root, "release", "win-unpacked", "openpond-app.exe"),
      path.join(root, "release", "win-unpacked", "openpond-app-nightly.exe"),
      path.join(root, "release", "win-ia32-unpacked", "openpond.exe"),
      path.join(root, "release", "win-ia32-unpacked", "openpond nightly.exe"),
      path.join(root, "release", "win-ia32-unpacked", "openpond-app.exe"),
      path.join(root, "release", "win-ia32-unpacked", "openpond-app-nightly.exe"),
      path.join(root, "release", "win-arm64-unpacked", "openpond.exe"),
      path.join(root, "release", "win-arm64-unpacked", "openpond nightly.exe"),
      path.join(root, "release", "win-arm64-unpacked", "openpond-app.exe"),
      path.join(root, "release", "win-arm64-unpacked", "openpond-app-nightly.exe"),
    ];
  }
  const linuxAppImages = existingFiles(path.join(root, "release"))
    .filter((file) => file.endsWith(".AppImage"))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => path.join(root, "release", file));
  return [
    path.join(root, "release", "linux-unpacked", "openpond-app"),
    path.join(root, "release", "linux-unpacked", "openpond-app-nightly"),
    path.join(root, "release", "linux-unpacked", "openpond"),
    path.join(root, "release", "linux-unpacked", "openpond nightly"),
    ...linuxAppImages,
    path.join(root, "release", "openpond-0.0.1.AppImage"),
  ];
}

function existingFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function launchTargetForPath(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): LaunchTarget {
  if (platform === "darwin" && appPath.endsWith(".app")) {
    const executableName = path.basename(appPath, ".app");
    return {
      command: path.join(appPath, "Contents", "MacOS", executableName),
      args: [],
      appPath,
    };
  }
  return { command: appPath, args: [], appPath };
}

function launchPackagedApp(
  target: LaunchTarget,
  options: { appHome: string; userData: string; devtoolsPort: number },
): ChildProcessWithoutNullStreams {
  const appArgs = [
    ...target.args,
    `--remote-debugging-port=${options.devtoolsPort}`,
    `--user-data-dir=${options.userData}`,
    "--disable-gpu",
    "--no-sandbox",
  ];
  const wrapped = wrapForDisplay(target.command, appArgs);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      OPENPOND_APP_HOME: options.appHome,
      OPENPOND_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.join("").length > 32_000) stderr.splice(0, stderr.length - 20);
  });
  child.on("exit", (code, signal) => {
    if (code === 0 || signal) return;
    console.error(`Packaged desktop exited early with code ${code}. stderr:\n${stderr.join("")}`);
  });
  return child;
}

function wrapForDisplay(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "linux" || process.env.DISPLAY) return { command, args };
  if (commandExists("xvfb-run")) return { command: "xvfb-run", args: ["-a", command, ...args] };
  throw new Error("No DISPLAY is available. Install xvfb and rerun through xvfb-run for Linux packaged desktop smoke.");
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return pathValue.split(path.delimiter).some((dir) =>
    extensions.some((extension) => {
      try {
        const candidate = path.join(dir, `${command}${extension}`);
        return Bun.file(candidate).size > 0;
      } catch {
        return false;
      }
    }),
  );
}

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>OpenPond Smoke Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      button, input { font: inherit; padding: 10px 12px; margin: 8px 0; }
      #smoke-result { margin-top: 16px; }
    </style>
  </head>
  <body>
    <h1>OpenPond Smoke Fixture</h1>
    <button id="smoke-button" aria-label="Smoke click target" type="button">Click target</button>
    <form id="smoke-form">
      <label for="smoke-input">Smoke text input</label>
      <input id="smoke-input" aria-label="Smoke text input" autocomplete="off">
      <button type="submit">Submit input</button>
    </form>
    <div id="smoke-result" role="status" data-clicked="false" data-submitted="false">Waiting</div>
    <script>
      const result = document.getElementById("smoke-result");
      const input = document.getElementById("smoke-input");
      document.getElementById("smoke-button").addEventListener("click", () => {
        result.dataset.clicked = "true";
        result.textContent = "Clicked";
      });
      document.getElementById("smoke-form").addEventListener("submit", (event) => {
        event.preventDefault();
        result.dataset.submitted = "true";
        result.dataset.typedLength = String(input.value.length);
        result.textContent = "Submitted";
      });
    </script>
  </body>
</html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port.");
  return { server, url: `http://127.0.0.1:${address.port}/` };
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

async function waitForDevtoolsTarget(port: number, timeoutMs: number): Promise<Required<DevtoolsTarget>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => (response.ok ? response.json() : null))
      .then((targets) => Array.isArray(targets) ? targets.find(isUsableTarget) : null)
      .catch(() => null);
    if (target) return target;
    await delay(250);
  }
  throw new Error("Timed out waiting for packaged desktop renderer DevTools target.");
}

async function waitForDevtoolsTargetUrl(
  port: number,
  targetUrl: string,
  timeoutMs: number,
): Promise<Required<DevtoolsTarget>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => (response.ok ? response.json() : null))
      .then((targets) =>
        Array.isArray(targets)
          ? targets.find((candidate) => isUsableTarget(candidate) && candidate.url === targetUrl)
          : null
      )
      .catch(() => null);
    if (target) return target;
    await delay(250);
  }
  throw new Error(`Timed out waiting for browser fixture DevTools target: ${targetUrl}`);
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

async function waitForRendererBridge(cdp: CdpClient, timeoutMs: number): Promise<void> {
  await waitFor(async () => evaluateValue<boolean>(
    cdp,
    `document.readyState !== "loading" &&
      typeof window.openpond === "object" &&
      typeof window.openpond.getConnection === "function" &&
      typeof window.openpond.browser?.open === "function"`,
  ), timeoutMs, "Timed out waiting for packaged renderer preload bridge.");
}

async function waitForBrowserState(
  cdp: CdpClient,
  conversationId: string,
  url: string,
  timeoutMs: number,
): Promise<{ activeTabId: string | null; tabs: Array<{ id: string; url: string; loading: boolean; error: string | null }> }> {
  return waitFor(async () => {
    const state = await evaluateValue<{
      activeTabId: string | null;
      tabs: Array<{ id: string; url: string; loading: boolean; error: string | null }>;
    }>(cdp, `window.openpond.browser.getState({ conversationId: ${JSON.stringify(conversationId)} })`);
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (active?.url === url && !active.loading && !active.error) return state;
    return null;
  }, timeoutMs, "Timed out waiting for browser sidebar fixture page to load.");
}

async function runBrowserInputProof(
  rendererCdp: CdpClient,
  fixtureCdp: CdpClient,
  conversationId: string,
  timeoutMs: number,
): Promise<BrowserInputProof> {
  const typedLength = "native input proof".length;
  const actionProof = await evaluateValue<{
    ok: boolean;
    error?: string;
    snapshotTargetCount: number;
    snapshotIdPresent: boolean;
    screenshotAvailable: boolean;
    moveOk: boolean;
    clickOk: boolean;
    typeOk: boolean;
    keyOk: boolean;
  }>(
    rendererCdp,
    `(async () => {
      const conversationId = ${JSON.stringify(conversationId)};
      const snapshotResult = await window.openpond.browser.snapshot({
        conversationId,
        maxTargets: 50,
        includeScreenshot: true
      });
      const snapshot = snapshotResult?.data?.snapshot;
      const targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [];
      const button = targets.find((target) =>
        /Smoke click target|Click target/i.test(String(target.name || target.text || ""))
      );
      const input = targets.find((target) =>
        /Smoke text input/i.test(String(target.name || target.text || ""))
      );
      if (!snapshotResult.ok || !snapshot?.snapshotId || !button?.ref || !input?.ref) {
        return {
          ok: false,
          error: "Missing browser snapshot refs",
          snapshotTargetCount: targets.length,
          snapshotIdPresent: Boolean(snapshot?.snapshotId),
          screenshotAvailable: Boolean(snapshotResult?.metadata?.screenshot),
          moveOk: false,
          clickOk: false,
          typeOk: false,
          keyOk: false
        };
      }
      const move = await window.openpond.browser.moveCursor({
        conversationId,
        snapshotId: snapshot.snapshotId,
        targetRef: button.ref,
        waitAfterMoveMs: 80
      });
      const click = await window.openpond.browser.click({
        conversationId,
        snapshotId: snapshot.snapshotId,
        targetRef: button.ref
      });
      const type = await window.openpond.browser.typeText({
        conversationId,
        snapshotId: snapshot.snapshotId,
        targetRef: input.ref,
        text: "native input proof"
      });
      const key = await window.openpond.browser.key({ conversationId, key: "Enter" });
      return {
        ok: Boolean(move.ok && click.ok && type.ok && key.ok),
        error: [move, click, type, key].find((result) => !result.ok)?.output,
        snapshotTargetCount: targets.length,
        snapshotIdPresent: true,
        screenshotAvailable: Boolean(snapshotResult?.metadata?.screenshot),
        moveOk: Boolean(move.ok),
        clickOk: Boolean(click.ok),
        typeOk: Boolean(type.ok),
        keyOk: Boolean(key.ok)
      };
    })()`,
  );
  if (!actionProof.ok) {
    throw new Error(actionProof.error ?? "Browser harness input proof failed.");
  }
  let lastFixtureState: {
    clicked: boolean;
    submitted: boolean;
    typedLength: number;
    inputLength: number;
    cursorOverlay: boolean;
  } | null = null;
  const fixtureProof = await waitFor(async () => {
    const state = await evaluateValue<{
      clicked: boolean;
      submitted: boolean;
      typedLength: number;
      inputLength: number;
      cursorOverlay: boolean;
    }>(
      fixtureCdp,
      `(() => {
        const result = document.getElementById("smoke-result");
        const input = document.getElementById("smoke-input");
        return {
          clicked: result?.dataset.clicked === "true",
          submitted: result?.dataset.submitted === "true",
          typedLength: Number(result?.dataset.typedLength || 0),
          inputLength: input && "value" in input ? input.value.length : 0,
          cursorOverlay: Boolean(document.getElementById("__openpond_agent_cursor_root"))
        };
      })()`,
    );
    lastFixtureState = state;
    if (
      state.clicked &&
      state.submitted &&
      state.typedLength === typedLength &&
      state.inputLength === typedLength &&
      state.cursorOverlay
    ) {
      return state;
    }
    return null;
  }, timeoutMs, () =>
    `Timed out waiting for native browser input proof. Last fixture state: ${JSON.stringify(lastFixtureState)}`,
  );
  return {
    snapshotTargetCount: actionProof.snapshotTargetCount,
    snapshotIdPresent: actionProof.snapshotIdPresent,
    screenshotAvailable: actionProof.screenshotAvailable,
    moveOk: actionProof.moveOk,
    clickOk: actionProof.clickOk,
    typeOk: actionProof.typeOk,
    keyOk: actionProof.keyOk,
    clicked: fixtureProof.clicked,
    submitted: fixtureProof.submitted,
    typedLength: fixtureProof.typedLength,
    cursorOverlay: fixtureProof.cursorOverlay,
  };
}

async function waitForBrowserDetached(
  cdp: CdpClient,
  timeoutMs: number,
): Promise<{ attachedRuntimeCount: number | null; proof: "diagnostics" | "ipc" }> {
  const hasDiagnostics = await evaluateValue<boolean>(
    cdp,
    `typeof window.openpond.browser.diagnostics === "function"`,
  );
  if (!hasDiagnostics) return { attachedRuntimeCount: null, proof: "ipc" };
  return waitFor(async () => {
    const diagnostics = await evaluateValue<{ attachedRuntimeCount: number }>(
      cdp,
      "window.openpond.browser.diagnostics()",
    );
    return diagnostics.attachedRuntimeCount === 0
      ? { attachedRuntimeCount: diagnostics.attachedRuntimeCount, proof: "diagnostics" }
      : null;
  }, timeoutMs, "Timed out waiting for browser sidebar to detach after close.");
}

async function triggerWindowClose(cdp: CdpClient): Promise<void> {
  try {
    await evaluateValue<boolean>(cdp, "window.openpond.closeWindow()");
  } catch (error) {
    if (error instanceof Error && /CDP socket closed/i.test(error.message)) return;
    throw error;
  }
}

async function measureFirstChatInputLatency(cdp: CdpClient): Promise<{ durationMs: number }> {
  return waitFor(async () => {
    const input = await evaluateValue<{ ok: boolean; ready: boolean; durationMs: number; value?: string; error?: string }>(
      cdp,
      `new Promise((resolve) => {
        const target = document.querySelector(
          ".composer-inline-input[role='textbox'], [role='textbox'][contenteditable], textarea"
        );
        if (!(target instanceof HTMLElement)) {
          resolve({ ok: false, ready: false, durationMs: 0, error: "composer textbox not found" });
          return;
        }
        const probeText = "Phase 0 latency probe";
        const started = performance.now();
        target.focus();
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value");
          descriptor?.set?.call(target, probeText);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: probeText
          }));
        } else {
          const inserted = document.execCommand("insertText", false, probeText);
          if (!inserted) {
            target.textContent = probeText;
            target.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: probeText
            }));
          }
        }
        requestAnimationFrame(() => {
          const value = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
            ? target.value
            : target.textContent || "";
          resolve({
            ok: value.includes(probeText),
            ready: true,
            durationMs: performance.now() - started,
            value
          });
        });
      })`,
    );
    if (!input.ready) return null;
    if (!input.ok) throw new Error(input.error ?? "Packaged composer input latency probe failed.");
    return { durationMs: Math.round(input.durationMs * 100) / 100 };
  }, 15_000, "Timed out waiting for packaged composer input.");
}

async function waitFor<T>(
  probe: () => Promise<T | null | false>,
  timeoutMs: number,
  message: string | (() => string),
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
  const resolvedMessage = typeof message === "function" ? message() : message;
  throw new Error(lastError ? `${resolvedMessage} Last error: ${String(lastError)}` : resolvedMessage);
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
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json() as T;
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

function redactLoopbackUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}:${url.port || "(default)"}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
