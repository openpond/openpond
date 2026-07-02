import { execFile, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BudgetWarning = {
  id: string;
  message: string;
  actual: number;
  threshold: number;
  unit: "bytes" | "ms";
};

export type RendererBundleMetrics = {
  webDist: string;
  totalJsBytes: number;
  totalCssBytes: number;
  initialAssetBytes: number;
  largestAssets: Array<{ path: string; bytes: number }>;
};

export type RendererBundleBudgets = {
  maxTotalJsBytes: number;
  maxTotalCssBytes: number;
  maxInitialAssetBytes: number;
  maxLargestAssetBytes: number;
};

export type StartupBudgets = {
  maxServerReadyMs: number;
  maxHealthMs: number;
};

export type ServerRouteMetric = {
  id: "bootstrap" | "workspace-diff" | "event-page";
  label: string;
  path: string;
  ok: boolean;
  status: number;
  durationMs: number;
  responseBytes: number;
  error?: string;
};

export type ServerRouteMetrics = {
  bootstrap: ServerRouteMetric;
  workspaceDiff: ServerRouteMetric;
  eventPage: ServerRouteMetric;
};

export type ServerRouteBudgets = {
  maxBootstrapMs: number;
  maxBootstrapBytes: number;
  maxWorkspaceDiffMs: number;
  maxWorkspaceDiffBytes: number;
  maxEventPageMs: number;
  maxEventPageBytes: number;
};

export type StartupMetrics =
  | {
      ok: true;
      serverReadyMs: number;
      healthMs: number;
      serverUrl: string;
      routes: ServerRouteMetrics;
    }
  | {
      ok: false;
      error: string;
      serverReadyMs: number | null;
      healthMs: number | null;
    };

export const DEFAULT_RENDERER_BUNDLE_BUDGETS: RendererBundleBudgets = {
  maxTotalJsBytes: 16 * 1024 * 1024,
  maxTotalCssBytes: 512 * 1024,
  maxInitialAssetBytes: 1.5 * 1024 * 1024,
  maxLargestAssetBytes: 8 * 1024 * 1024,
};

export const DEFAULT_STARTUP_BUDGETS: StartupBudgets = {
  maxServerReadyMs: 5_000,
  maxHealthMs: 750,
};

export const DEFAULT_SERVER_ROUTE_BUDGETS: ServerRouteBudgets = {
  maxBootstrapMs: 3_000,
  maxBootstrapBytes: 2 * 1024 * 1024,
  maxWorkspaceDiffMs: 1_500,
  maxWorkspaceDiffBytes: 1024 * 1024,
  maxEventPageMs: 500,
  maxEventPageBytes: 256 * 1024,
};

export async function collectRendererBundleMetrics(webDist: string): Promise<RendererBundleMetrics> {
  const files = await listFiles(webDist);
  const assets = await Promise.all(
    files.map(async (filePath) => ({
      path: path.relative(webDist, filePath),
      bytes: (await fs.stat(filePath)).size,
    })),
  );
  const indexHtml = await fs.readFile(path.join(webDist, "index.html"), "utf8").catch(() => "");
  const initialAssetPaths = initialAssetsFromIndexHtml(indexHtml);
  const sizeByPath = new Map(assets.map((asset) => [asset.path.replaceAll("\\", "/"), asset.bytes]));
  return {
    webDist,
    totalJsBytes: assets
      .filter((asset) => asset.path.endsWith(".js"))
      .reduce((sum, asset) => sum + asset.bytes, 0),
    totalCssBytes: assets
      .filter((asset) => asset.path.endsWith(".css"))
      .reduce((sum, asset) => sum + asset.bytes, 0),
    initialAssetBytes: initialAssetPaths.reduce((sum, assetPath) => sum + (sizeByPath.get(assetPath) ?? 0), 0),
    largestAssets: assets
      .filter((asset) => /\.(?:js|css|wasm|ttf)$/.test(asset.path))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 10),
  };
}

export function checkRendererBundleBudgets(
  metrics: RendererBundleMetrics,
  budgets: RendererBundleBudgets = DEFAULT_RENDERER_BUNDLE_BUDGETS,
): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];
  pushWarning(warnings, {
    id: "renderer-total-js",
    label: "Renderer total JavaScript",
    actual: metrics.totalJsBytes,
    threshold: budgets.maxTotalJsBytes,
    unit: "bytes",
  });
  pushWarning(warnings, {
    id: "renderer-total-css",
    label: "Renderer total CSS",
    actual: metrics.totalCssBytes,
    threshold: budgets.maxTotalCssBytes,
    unit: "bytes",
  });
  pushWarning(warnings, {
    id: "renderer-initial-assets",
    label: "Renderer initial assets",
    actual: metrics.initialAssetBytes,
    threshold: budgets.maxInitialAssetBytes,
    unit: "bytes",
  });
  const largest = metrics.largestAssets[0];
  if (largest) {
    pushWarning(warnings, {
      id: "renderer-largest-asset",
      label: `Renderer largest asset (${largest.path})`,
      actual: largest.bytes,
      threshold: budgets.maxLargestAssetBytes,
      unit: "bytes",
    });
  }
  return warnings;
}

export function checkStartupBudgets(
  metrics: StartupMetrics,
  budgets: StartupBudgets = DEFAULT_STARTUP_BUDGETS,
): BudgetWarning[] {
  if (!metrics.ok) {
    return [
      {
        id: "server-startup-probe",
        message: `Server startup probe did not complete: ${metrics.error}`,
        actual: metrics.serverReadyMs ?? 0,
        threshold: budgets.maxServerReadyMs,
        unit: "ms",
      },
    ];
  }
  const warnings: BudgetWarning[] = [];
  pushWarning(warnings, {
    id: "server-ready-ms",
    label: "Server ready time",
    actual: metrics.serverReadyMs,
    threshold: budgets.maxServerReadyMs,
    unit: "ms",
  });
  pushWarning(warnings, {
    id: "server-health-ms",
    label: "Server health response time",
    actual: metrics.healthMs,
    threshold: budgets.maxHealthMs,
    unit: "ms",
  });
  return warnings;
}

export function checkServerRouteBudgets(
  metrics: ServerRouteMetrics,
  budgets: ServerRouteBudgets = DEFAULT_SERVER_ROUTE_BUDGETS,
): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];
  pushRouteWarnings(warnings, metrics.bootstrap, {
    maxDurationMs: budgets.maxBootstrapMs,
    maxResponseBytes: budgets.maxBootstrapBytes,
  });
  pushRouteWarnings(warnings, metrics.workspaceDiff, {
    maxDurationMs: budgets.maxWorkspaceDiffMs,
    maxResponseBytes: budgets.maxWorkspaceDiffBytes,
  });
  pushRouteWarnings(warnings, metrics.eventPage, {
    maxDurationMs: budgets.maxEventPageMs,
    maxResponseBytes: budgets.maxEventPageBytes,
  });
  return warnings;
}

export async function measureServerStartup(input: {
  root: string;
  timeoutMs?: number;
}): Promise<StartupMetrics> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const serverEntry = path.join(input.root, "apps", "server", "dist", "index.js");
  const appHome = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-budget-startup-"));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-budget-codex-"));
  const child = spawn(process.env.NODE_BINARY || "node", [serverEntry, "--port", "0"], {
    cwd: input.root,
    env: {
      ...process.env,
      OPENPOND_APP_HOME: appHome,
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readyMs: number | null = null;
  let serverUrl: string | null = null;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);

  try {
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const ready = readyPayload(stdout);
      if (!ready) return;
      readyMs = Date.now() - started;
      serverUrl = ready.url;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    while (!serverUrl && Date.now() - started < timeoutMs && child.exitCode === null) {
      await delay(25);
    }
    if (!serverUrl) {
      return {
        ok: false,
        error: stderr.trim() || "server did not print ready payload before timeout",
        serverReadyMs: readyMs,
        healthMs: null,
      };
    }

    const healthStarted = Date.now();
    const response = await fetch(`${serverUrl}/health`);
    const healthMs = Date.now() - healthStarted;
    if (!response.ok) {
      return {
        ok: false,
        error: `/health returned ${response.status}`,
        serverReadyMs: readyMs,
        healthMs,
      };
    }
    const token = (await fs.readFile(path.join(appHome, "token"), "utf8")).trim();
    const routes = await collectServerRouteMetrics({ serverUrl, token }).catch((error) =>
      failedServerRouteMetrics(
        serverUrl,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return {
      ok: true,
      serverReadyMs: readyMs ?? Date.now() - started,
      healthMs,
      serverUrl,
      routes,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      serverReadyMs: readyMs,
      healthMs: null,
    };
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit").catch(() => undefined);
    await fs.rm(appHome, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
  }
}

export async function collectServerRouteMetrics(input: {
  serverUrl: string;
  token: string;
}): Promise<ServerRouteMetrics> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-budget-routes-repo-"));
  try {
    const bootstrap = await measureJsonRoute({
      serverUrl: input.serverUrl,
      token: input.token,
      id: "bootstrap",
      label: "Bootstrap",
      path: "/v1/bootstrap?ensureProfile=0",
    });
    const session = await requestJson<{ id: string }>({
      serverUrl: input.serverUrl,
      token: input.token,
      path: "/v1/sessions",
      init: {
        method: "POST",
        body: JSON.stringify({
          provider: "codex",
          title: "route budget event page",
          cwd: process.cwd(),
        }),
      },
    });
    const eventPage = await measureJsonRoute({
      serverUrl: input.serverUrl,
      token: input.token,
      id: "event-page",
      label: "Event page",
      path: `/v1/events/page?sessionId=${encodeURIComponent(session.id)}&afterSequence=0&limit=25`,
    });

    await createRouteBudgetRepo(repoDir);
    const workspaceDiff = await collectWorkspaceDiffRouteMetric(input.serverUrl, input.token, repoDir);

    return {
      bootstrap,
      workspaceDiff,
      eventPage,
    };
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const webDist = path.join(root, "apps", "web", "dist");
  const warnings: BudgetWarning[] = [];
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  try {
    const renderer = await collectRendererBundleMetrics(webDist);
    report.renderer = renderer;
    warnings.push(...checkRendererBundleBudgets(renderer));
  } catch (error) {
    warnings.push({
      id: "renderer-bundle-probe",
      message: `Renderer bundle budget probe could not read ${path.relative(root, webDist)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      actual: 0,
      threshold: 0,
      unit: "bytes",
    });
  }

  const startup = await measureServerStartup({ root });
  warnings.push(...checkStartupBudgets(startup));
  if (startup.ok) {
    const { routes, ...startupReport } = startup;
    report.startup = startupReport;
    report.serverRoutes = routes;
    warnings.push(...checkServerRouteBudgets(routes));
  } else {
    report.startup = startup;
  }

  console.log(JSON.stringify(report, null, 2));
  if (warnings.length === 0) {
    console.log("Performance budget warnings: none");
    return;
  }
  for (const warning of warnings) {
    console.warn(`[budget-warning] ${warning.id}: ${warning.message}`);
  }
}

async function measureJsonRoute(input: {
  serverUrl: string;
  token: string;
  id: ServerRouteMetric["id"];
  label: string;
  path: string;
}): Promise<ServerRouteMetric> {
  const started = Date.now();
  const response = await authorizedFetch(input.serverUrl, input.token, input.path);
  const text = await response.text();
  return {
    id: input.id,
    label: input.label,
    path: input.path,
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - started,
    responseBytes: Buffer.byteLength(text, "utf8"),
  };
}

async function collectWorkspaceDiffRouteMetric(
  serverUrl: string,
  token: string,
  repoDir: string,
): Promise<ServerRouteMetric> {
  try {
    const projectPayload = await requestJson<{ project: { id: string } }>({
      serverUrl,
      token,
      path: "/v1/projects",
      init: {
        method: "POST",
        body: JSON.stringify({ path: repoDir }),
      },
    });
    await fs.appendFile(path.join(repoDir, "README.md"), "\nroute budget changed line\n", "utf8");
    return measureJsonRoute({
      serverUrl,
      token,
      id: "workspace-diff",
      label: "Workspace diff",
      path: `/v1/workspaces/${encodeURIComponent(projectPayload.project.id)}/diff`,
    });
  } catch (error) {
    return failedRouteMetric(
      "workspace-diff",
      "Workspace diff",
      "/v1/workspaces/<created-project>/diff",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function requestJson<T>(input: {
  serverUrl: string;
  token: string;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const response = await authorizedFetch(input.serverUrl, input.token, input.path, input.init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${input.path} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

async function authorizedFetch(
  serverUrl: string,
  token: string,
  routePath: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${serverUrl}${routePath}`, {
    ...init,
    headers,
  });
}

async function createRouteBudgetRepo(repoDir: string): Promise<void> {
  await fs.writeFile(path.join(repoDir, "README.md"), "# Route Budget Repo\n", "utf8");
  await runGit(repoDir, ["init"]);
  await runGit(repoDir, ["add", "README.md"]);
  await runGit(repoDir, [
    "-c",
    "user.email=openpond-route-budget@example.local",
    "-c",
    "user.name=OpenPond Route Budget",
    "commit",
    "-m",
    "initial route budget fixture",
  ]);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
    }),
  );
  return files.flat();
}

function initialAssetsFromIndexHtml(indexHtml: string): string[] {
  const assets = new Set<string>();
  for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1];
    const normalized = raw?.replace(/^\.\//, "").replace(/^\//, "");
    if (!normalized || !normalized.startsWith("assets/")) continue;
    assets.add(normalized);
  }
  return [...assets];
}

function pushWarning(
  warnings: BudgetWarning[],
  input: {
    id: string;
    label: string;
    actual: number;
    threshold: number;
    unit: BudgetWarning["unit"];
  },
): void {
  if (input.actual <= input.threshold) return;
  warnings.push({
    id: input.id,
    message: `${input.label} is ${formatMetric(input.actual, input.unit)}; warning threshold is ${formatMetric(input.threshold, input.unit)}.`,
    actual: input.actual,
    threshold: input.threshold,
    unit: input.unit,
  });
}

function pushRouteWarnings(
  warnings: BudgetWarning[],
  metric: ServerRouteMetric,
  budget: {
    maxDurationMs: number;
    maxResponseBytes: number;
  },
): void {
  if (!metric.ok) {
    warnings.push({
      id: `${metric.id}-route-status`,
      message: metric.error
        ? `${metric.label} route probe failed: ${metric.error}`
        : `${metric.label} returned HTTP ${metric.status}.`,
      actual: metric.status,
      threshold: 200,
      unit: "ms",
    });
    return;
  }
  pushWarning(warnings, {
    id: `${metric.id}-route-ms`,
    label: `${metric.label} response time`,
    actual: metric.durationMs,
    threshold: budget.maxDurationMs,
    unit: "ms",
  });
  pushWarning(warnings, {
    id: `${metric.id}-route-bytes`,
    label: `${metric.label} response size`,
    actual: metric.responseBytes,
    threshold: budget.maxResponseBytes,
    unit: "bytes",
  });
}

function failedServerRouteMetrics(serverUrl: string, error: string): ServerRouteMetrics {
  return {
    bootstrap: failedRouteMetric("bootstrap", "Bootstrap", `${serverUrl}/v1/bootstrap?ensureProfile=0`, error),
    workspaceDiff: failedRouteMetric(
      "workspace-diff",
      "Workspace diff",
      `${serverUrl}/v1/workspaces/<created-project>/diff`,
      error,
    ),
    eventPage: failedRouteMetric("event-page", "Event page", `${serverUrl}/v1/events/page?afterSequence=0&limit=25`, error),
  };
}

function failedRouteMetric(
  id: ServerRouteMetric["id"],
  label: string,
  routePath: string,
  error: string,
): ServerRouteMetric {
  return {
    id,
    label,
    path: routePath,
    ok: false,
    status: 0,
    durationMs: 0,
    responseBytes: 0,
    error,
  };
}

function formatMetric(value: number, unit: BudgetWarning["unit"]): string {
  if (unit === "ms") return `${Math.round(value)}ms`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} bytes`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.warn(`[budget-warning] performance budget script failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  });
}
