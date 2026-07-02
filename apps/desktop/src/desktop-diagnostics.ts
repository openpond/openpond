import { app, clipboard, shell } from "electron";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appDisplayName,
  appHomePath,
  desktopLogger,
  diagnosticsDirPath,
  logDirPath,
  releaseChannel,
} from "./desktop-environment.js";
import {
  collectDesktopDiagnostics,
  type DesktopDiagnosticsServerConnection,
  type DesktopDiagnosticsSummary,
  type DesktopDiagnosticsRequestSummary,
  type DesktopDiagnosticsResourceSummary,
} from "./desktop-diagnostics-collector.js";

const RECENT_LOG_LINE_LIMIT = 1000;
const MAX_RECENT_LOG_LINE_LIMIT = 5000;

export async function openLogsFolder(): Promise<{ ok: boolean; error?: string }> {
  await fs.mkdir(logDirPath(), { recursive: true });
  return openLocalPath(logDirPath(), "logs");
}

export async function exportDiagnostics(
  options: {
    serverConnection?: () => DesktopDiagnosticsServerConnection | null | Promise<DesktopDiagnosticsServerConnection | null>;
    requests?: () => DesktopDiagnosticsRequestSummary | undefined;
    resources?: () => DesktopDiagnosticsResourceSummary | undefined;
  } = {},
): Promise<{ ok: boolean; path?: string; error?: string }> {
  await desktopLogger().flush();
  const targetDir = path.join(diagnosticsDirPath(), `support-${timestampForPath()}`);
  await fs.mkdir(targetDir, { recursive: true });
  const recent = await recentDiagnosticsText(RECENT_LOG_LINE_LIMIT);
  const summary = await collectDesktopDiagnostics({
    desktop: diagnosticsSummary(),
    serverConnection: await resolveServerConnection(options.serverConnection),
    requests: resolveRequestDiagnostics(options.requests),
    resources: resolveResourceDiagnostics(options.resources),
    logs: {
      lineLimit: RECENT_LOG_LINE_LIMIT,
      lines: recent.lines,
    },
  });
  await fs.writeFile(path.join(targetDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(targetDir, "diagnostics.txt"), recent.text, "utf8");
  try {
    const logFiles = await fs.readdir(logDirPath());
    const logsDir = path.join(targetDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    await Promise.all(
      logFiles.map(async (file) => {
        await fs.copyFile(path.join(logDirPath(), file), path.join(logsDir, file));
      })
    );
  } catch (error) {
    desktopLogger().warn("diagnostics log copy failed", { error });
  }
  return { ...openLocalPath(targetDir, "diagnostics"), path: targetDir };
}

function resolveRequestDiagnostics(
  requests?: () => DesktopDiagnosticsRequestSummary | undefined,
): DesktopDiagnosticsRequestSummary | undefined {
  if (!requests) return undefined;
  try {
    return requests();
  } catch (error) {
    desktopLogger().warn("diagnostics request snapshot failed", { error });
    return undefined;
  }
}

function resolveResourceDiagnostics(
  resources?: () => DesktopDiagnosticsResourceSummary | undefined,
): DesktopDiagnosticsResourceSummary | undefined {
  if (!resources) return undefined;
  try {
    return resources();
  } catch (error) {
    desktopLogger().warn("diagnostics resource snapshot failed", { error });
    return undefined;
  }
}

export async function copyRecentLogs(lineLimit = RECENT_LOG_LINE_LIMIT): Promise<{ ok: boolean; lines?: number; error?: string }> {
  try {
    const recent = await recentDiagnosticsText(lineLimit);
    clipboard.writeText(recent.text);
    desktopLogger().info("recent logs copied", { lines: recent.lines });
    return { ok: true, lines: recent.lines };
  } catch (error) {
    desktopLogger().warn("recent logs copy failed", { error });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readRecentLogs(
  lineLimit = 100
): Promise<{ ok: true; logDir: string; lineLimit: number; lines: RecentLogLine[] } | { ok: false; error: string }> {
  try {
    await desktopLogger().flush();
    const limit = normalizeLogLineLimit(lineLimit);
    return {
      ok: true,
      logDir: logDirPath(),
      lineLimit: limit,
      lines: await recentLogLines(limit),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function diagnosticsSummary(): DesktopDiagnosticsSummary {
  return {
    app: appDisplayName(),
    version: app.getVersion(),
    releaseChannel: releaseChannel(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    appHome: appHomePath(),
    logDir: logDirPath(),
    createdAt: new Date().toISOString(),
  };
}

async function resolveServerConnection(
  serverConnection?: () => DesktopDiagnosticsServerConnection | null | Promise<DesktopDiagnosticsServerConnection | null>,
): Promise<DesktopDiagnosticsServerConnection | null> {
  if (!serverConnection) return null;
  try {
    return await serverConnection();
  } catch (error) {
    desktopLogger().warn("diagnostics server connection lookup failed", { error });
    return null;
  }
}

type RecentLogLine = {
  file: string;
  line: string;
  timestamp: number;
  index: number;
};

async function recentDiagnosticsText(lineLimit: number): Promise<{ text: string; lines: number }> {
  await desktopLogger().flush();
  const limit = normalizeLogLineLimit(lineLimit);
  const lines = await recentLogLines(limit);
  const summary = diagnosticsSummary();
  const text = [
    "OpenPond diagnostics",
    `Created: ${summary.createdAt}`,
    `App: ${summary.app} ${summary.version}`,
    `Release: ${summary.releaseChannel}`,
    `Runtime: ${summary.platform}/${summary.arch}`,
    `Log dir: ${summary.logDir}`,
    `Lines: ${lines.length}`,
    "",
    ...lines.map((entry) => `[${entry.file}] ${entry.line}`),
    "",
  ].join("\n");
  return { text, lines: lines.length };
}

async function recentLogLines(lineLimit: number): Promise<RecentLogLine[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(logDirPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const logFiles = files.filter((file) => /\.log(?:\.\d+)?$/.test(file));
  const lines = (
    await Promise.all(
      logFiles.map(async (file) => {
        const content = await fs.readFile(path.join(logDirPath(), file), "utf8");
        return content
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-lineLimit)
          .map((line, index) => ({
            file,
            line,
            timestamp: logLineTimestamp(line),
            index,
          }));
      })
    )
  ).flat();
  lines.sort(
    (left, right) =>
      left.timestamp - right.timestamp || left.file.localeCompare(right.file) || left.index - right.index
  );
  return lines.slice(-lineLimit);
}

function normalizeLogLineLimit(lineLimit: number): number {
  if (!Number.isFinite(lineLimit)) return RECENT_LOG_LINE_LIMIT;
  return Math.max(1, Math.min(MAX_RECENT_LOG_LINE_LIMIT, Math.trunc(lineLimit)));
}

function logLineTimestamp(line: string): number {
  try {
    const record = JSON.parse(line) as { ts?: unknown };
    if (typeof record.ts !== "string") return 0;
    const timestamp = Date.parse(record.ts);
    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
}

export function lineLimitFromPayload(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object" || !("lineLimit" in payload)) return undefined;
  const lineLimit = (payload as { lineLimit?: unknown }).lineLimit;
  return typeof lineLimit === "number" ? lineLimit : undefined;
}

function openLocalPath(targetPath: string, label: string): { ok: boolean; error?: string } {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [targetPath] }
      : process.platform === "win32"
        ? { command: "explorer.exe", args: [targetPath] }
        : { command: "xdg-open", args: [targetPath] };
  try {
    const child = spawn(opener.command, opener.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      desktopLogger().warn("open local path failed", { label, targetPath, error });
    });
    child.unref();
    desktopLogger().info("open local path requested", { label, targetPath, command: opener.command });
    return { ok: true };
  } catch (error) {
    desktopLogger().warn("open local path failed", { label, targetPath, error });
    try {
      shell.showItemInFolder(targetPath);
      return { ok: true };
    } catch (fallbackError) {
      desktopLogger().warn("show local path fallback failed", { label, targetPath, error: fallbackError });
      return {
        ok: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      };
    }
  }
}
