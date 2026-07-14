import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopHarnessApiClient, readHarnessToken } from "./api.js";
import { CdpClient, CdpDesktopHarnessRenderer, waitForDevtoolsTarget, waitForRendererBridge } from "./cdp.js";
import { DesktopHarnessEventWaiter, eventLabel } from "./events.js";
import {
  launchIsolatedDesktopHarness,
  launchPackagedDesktopHarness,
  type IsolatedDesktopHarness,
  type PackagedDesktopHarness,
} from "./launch.js";
import type {
  DesktopHarness,
  DesktopHarnessConnection,
  DesktopHarnessLaunchMode,
  DesktopHarnessRunOptions,
  DesktopHarnessRunReport,
  DesktopHarnessScenarioDefinition,
  DesktopHarnessScenarioReport,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type HarnessRuntime = {
  connection: DesktopHarnessConnection | null;
  cdp: CdpClient | null;
  restart?(): Promise<{ connection: DesktopHarnessConnection; cdp: CdpClient | null }>;
  close(): Promise<void>;
};

type ScenarioState = {
  events: string[];
  eventIds: string[];
  rendererAssertions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  screenshots: string[];
};

export async function runDesktopHarness(options: DesktopHarnessRunOptions): Promise<DesktopHarnessRunReport> {
  const repoRoot = path.resolve(options.repoRoot ?? ROOT);
  const startedAtMs = Date.now();
  const now = options.now ?? (() => new Date());
  const artifactsDir = path.resolve(options.artifactsDir ?? defaultArtifactsDir(repoRoot, now()));
  await mkdir(artifactsDir, { recursive: true });

  const runtime = await createRuntime({
    ...options,
    repoRoot,
    artifactsDir,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const reports: DesktopHarnessScenarioReport[] = [];
  try {
    const scenarios = await loadScenarios(options.scenarioPaths, repoRoot);
    const filtered = filterScenarios(scenarios, options.grep ?? null);
    if (filtered.length === 0) throw new Error("No desktop harness scenarios matched the requested selection.");
    for (const scenario of filtered) {
      reports.push(await runScenario({
        scenario,
        runtime,
        repoRoot,
        artifactsDir,
        launchMode: options.launchMode,
        timeoutMs: scenario.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }));
    }
  } finally {
    await runtime.close();
  }

  const report: DesktopHarnessRunReport = {
    ok: reports.every((scenario) => scenario.ok),
    generatedAt: now().toISOString(),
    mode: options.launchMode,
    repoRoot,
    artifactsDir,
    scenarios: reports,
    timings: {
      totalMs: Date.now() - startedAtMs,
    },
  };
  await writeRunReport(report, options.jsonPath);
  return report;
}

async function runScenario(input: {
  scenario: DesktopHarnessScenarioDefinition;
  runtime: HarnessRuntime;
  repoRoot: string;
  artifactsDir: string;
  launchMode: DesktopHarnessLaunchMode;
  timeoutMs: number;
}): Promise<DesktopHarnessScenarioReport> {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const state: ScenarioState = {
    events: [],
    eventIds: [],
    rendererAssertions: {},
    metadata: {},
    screenshots: [],
  };
  let api = new DesktopHarnessApiClient(input.runtime.connection);
  let renderer = new CdpDesktopHarnessRenderer(input.runtime.cdp, path.join(input.artifactsDir, input.scenario.name), input.timeoutMs);
  let events = new DesktopHarnessEventWaiter(api, input.timeoutMs, (event) => {
    state.events.push(eventLabel(event));
    if (event.id) state.eventIds.push(event.id);
  });
  const harness: DesktopHarness = {
    repoRoot: input.repoRoot,
    artifactsDir: path.join(input.artifactsDir, input.scenario.name),
    launchMode: input.launchMode,
    timeoutMs: input.timeoutMs,
    get api() { return api; },
    get renderer() { return renderer; },
    get events() { return events; },
    restart: input.runtime.restart ? async () => {
      renderer.close();
      const restarted = await input.runtime.restart!();
      api = new DesktopHarnessApiClient(restarted.connection);
      renderer = new CdpDesktopHarnessRenderer(restarted.cdp, path.join(input.artifactsDir, input.scenario.name), input.timeoutMs);
      events = new DesktopHarnessEventWaiter(api, input.timeoutMs, (event) => {
        state.events.push(eventLabel(event));
        if (event.id) state.eventIds.push(event.id);
      });
    } : undefined,
    uniqueTitle(prefix: string) {
      return `${prefix}-${Date.now().toString(36)}`;
    },
    recordEvent(label: string) {
      state.events.push(label);
    },
    recordAssertion(name: string, value: unknown) {
      state.rendererAssertions[name] = value;
    },
    recordMetadata(values: Record<string, unknown>) {
      Object.assign(state.metadata, values);
    },
    async screenshot(name: string) {
      const screenshotPath = await renderer.screenshot(name);
      state.screenshots.push(screenshotPath);
      return screenshotPath;
    },
  };

  try {
    await mkdir(harness.artifactsDir, { recursive: true });
    await withTimeout(Promise.resolve(input.scenario.run(harness)), input.timeoutMs, `Scenario ${input.scenario.name} timed out.`);
    const completedAt = new Date();
    return {
      name: input.scenario.name,
      ok: true,
      mode: input.launchMode,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      events: state.events,
      eventIds: state.eventIds,
      rendererAssertions: state.rendererAssertions,
      metadata: state.metadata,
      screenshots: state.screenshots,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (renderer.connected) {
      try {
        state.screenshots.push(await renderer.screenshot(`failure-${input.scenario.name}`));
      } catch {
        // A failure screenshot is useful when available, but the original error remains authoritative.
      }
    }
    const completedAt = new Date();
    return {
      name: input.scenario.name,
      ok: false,
      mode: input.launchMode,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      events: state.events,
      eventIds: state.eventIds,
      rendererAssertions: state.rendererAssertions,
      metadata: state.metadata,
      screenshots: state.screenshots,
      error: {
        message,
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      },
    };
  }
}

async function createRuntime(options: DesktopHarnessRunOptions & {
  repoRoot: string;
  artifactsDir: string;
  timeoutMs: number;
}): Promise<HarnessRuntime> {
  if (options.launchMode === "none") {
    return {
      connection: null,
      cdp: null,
      close: async () => {},
    };
  }

  if (options.launchMode === "isolated") {
    const isolated = await launchIsolatedDesktopHarness({
      repoRoot: options.repoRoot,
      timeoutMs: options.timeoutMs,
      keepHome: options.keepHome,
    });
    return isolatedRuntime(isolated);
  }

  if (options.launchMode === "packaged") {
    const packaged = await launchPackagedDesktopHarness({
      repoRoot: options.repoRoot,
      timeoutMs: options.timeoutMs,
      keepHome: options.keepHome,
      appPath: options.appPath,
    });
    return packagedRuntime(packaged);
  }

  const token = await readHarnessToken({
    token: options.token,
    tokenFile: options.tokenFile,
    defaultTokenFile: path.join(os.homedir(), ".openpond", "openpond-app", "token"),
  });
  if (!options.serverUrl) throw new Error("--server is required for --attach mode.");
  if (!token) throw new Error("--token or --token-file is required for --attach mode.");
  const cdp = options.devtoolsPort
    ? await attachCdp(options.devtoolsPort, options.timeoutMs, options.serverUrl)
    : null;
  return {
    connection: {
      serverUrl: options.serverUrl,
      token,
    },
    cdp,
    close: async () => {
      cdp?.close();
    },
  };
}

function isolatedRuntime(isolated: IsolatedDesktopHarness): HarnessRuntime {
  return {
    connection: isolated.connection,
    cdp: isolated.cdp,
    restart: isolated.restart,
    close: isolated.close,
  };
}

function packagedRuntime(packaged: PackagedDesktopHarness): HarnessRuntime {
  return {
    connection: packaged.connection,
    cdp: packaged.cdp,
    close: packaged.close,
  };
}

async function attachCdp(devtoolsPort: number, timeoutMs: number, serverUrl: string): Promise<CdpClient> {
  const target = await waitForDevtoolsTarget(devtoolsPort, timeoutMs, (candidate) =>
    candidate.url.startsWith("http://") || candidate.url.startsWith("https://"),
  );
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await waitForRendererBridge(cdp, timeoutMs);
  return cdp;
}

export async function loadScenarios(
  scenarioPaths: string[],
  repoRoot = ROOT,
): Promise<DesktopHarnessScenarioDefinition[]> {
  if (scenarioPaths.length === 0) throw new Error("At least one desktop harness scenario path is required.");
  const scenarios: DesktopHarnessScenarioDefinition[] = [];
  for (const scenarioPath of scenarioPaths) {
    const absolutePath = path.resolve(repoRoot, scenarioPath);
    const imported = await import(`${pathToFileURL(absolutePath).href}?desktopHarness=${Date.now()}`);
    const loaded = imported.default;
    const definitions = Array.isArray(loaded) ? loaded : [loaded];
    for (const definition of definitions) {
      assertScenarioDefinition(definition, scenarioPath);
      scenarios.push(definition);
    }
  }
  return scenarios;
}

export function filterScenarios(
  scenarios: DesktopHarnessScenarioDefinition[],
  grep: string | null,
): DesktopHarnessScenarioDefinition[] {
  if (!grep) return scenarios;
  const pattern = new RegExp(grep);
  return scenarios.filter((scenario) => pattern.test(scenario.name));
}

export async function writeRunReport(
  report: DesktopHarnessRunReport,
  jsonPath?: string | null,
): Promise<void> {
  if (!jsonPath) return;
  const outputPath = path.resolve(jsonPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function assertScenarioDefinition(value: unknown, source: string): asserts value is DesktopHarnessScenarioDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} did not export a desktop harness scenario.`);
  }
  const record = value as Partial<DesktopHarnessScenarioDefinition>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new Error(`${source} scenario is missing a non-empty name.`);
  }
  if (typeof record.run !== "function") {
    throw new Error(`${source} scenario "${record.name}" is missing a run function.`);
  }
}

function defaultArtifactsDir(repoRoot: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, "tmp", "desktop-harness", stamp);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
