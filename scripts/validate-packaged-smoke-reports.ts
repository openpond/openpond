import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ExpectedReport = {
  name: string;
  platform: NodeJS.Platform;
  requireWindowExit: boolean;
};

type SmokeReport = {
  ok?: unknown;
  platform?: unknown;
  renderer?: {
    readyState?: unknown;
  };
  server?: {
    health?: unknown;
  };
  browser?: {
    tabCount?: unknown;
    inputProof?: {
      snapshotTargetCount?: unknown;
      snapshotIdPresent?: unknown;
      screenshotAvailable?: unknown;
      moveOk?: unknown;
      clickOk?: unknown;
      typeOk?: unknown;
      keyOk?: unknown;
      clicked?: unknown;
      submitted?: unknown;
      typedLength?: unknown;
      cursorOverlay?: unknown;
    };
    attachedAfterClose?: unknown;
  };
  shutdown?: {
    exitedAfterClose?: unknown;
  };
  timings?: Record<string, unknown>;
};

const DEFAULT_EXPECTED_REPORTS: ExpectedReport[] = [
  { name: "linux-x64-appimage", platform: "linux", requireWindowExit: true },
  { name: "linux-arm64-appimage", platform: "linux", requireWindowExit: true },
  { name: "mac-arm64-zip", platform: "darwin", requireWindowExit: false },
  { name: "mac-x64-zip", platform: "darwin", requireWindowExit: false },
  // Temporarily disabled while Windows release builds are unstable.
  // { name: "windows-nsis", platform: "win32", requireWindowExit: true },
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await validatePackagedSmokeReports({
    dir: options.dir,
    expected: DEFAULT_EXPECTED_REPORTS,
  });
  console.log(JSON.stringify(summary, null, 2));
}

export async function validatePackagedSmokeReports(input: {
  dir: string;
  expected?: ExpectedReport[];
}): Promise<{
  ok: true;
  dir: string;
  reports: Array<{ name: string; platform: NodeJS.Platform; file: string }>;
}> {
  const dir = path.resolve(input.dir);
  const expected = input.expected ?? DEFAULT_EXPECTED_REPORTS;
  const files = await readdir(dir);
  const reports: Array<{ name: string; platform: NodeJS.Platform; file: string }> = [];
  for (const expectedReport of expected) {
    const file = files.find((candidate) => candidate === `smoke-${expectedReport.name}.json`);
    if (!file) {
      throw new Error(`Missing packaged smoke report for ${expectedReport.name}: expected smoke-${expectedReport.name}.json`);
    }
    const reportPath = path.join(dir, file);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as SmokeReport;
    validateSmokeReport(report, expectedReport, file);
    reports.push({
      name: expectedReport.name,
      platform: expectedReport.platform,
      file: path.relative(process.cwd(), reportPath),
    });
  }
  return { ok: true, dir: path.relative(process.cwd(), dir), reports };
}

function validateSmokeReport(report: SmokeReport, expected: ExpectedReport, file: string): void {
  if (report.ok !== true) throw new Error(`${file}: smoke report ok must be true`);
  if (report.platform !== expected.platform) {
    throw new Error(`${file}: expected platform ${expected.platform}, got ${String(report.platform)}`);
  }
  if (report.renderer?.readyState !== "complete") {
    throw new Error(`${file}: renderer readyState must be complete`);
  }
  if (report.server?.health !== "openpond-app-server") {
    throw new Error(`${file}: server health must be openpond-app-server`);
  }
  if (typeof report.browser?.tabCount !== "number" || report.browser.tabCount < 1) {
    throw new Error(`${file}: browser tabCount must be at least 1`);
  }
  validateBrowserInputProof(report.browser.inputProof, file);
  if (report.browser?.attachedAfterClose !== 0) {
    throw new Error(`${file}: browser attachedAfterClose must be 0`);
  }
  if (expected.requireWindowExit && report.shutdown?.exitedAfterClose !== true) {
    throw new Error(`${file}: shutdown exitedAfterClose must be true`);
  }
  for (const key of ["desktopStartupMs", "initialRendererReadyMs", "serverHealthMs", "firstChatInputLatencyMs"]) {
    const value = report.timings?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${file}: timings.${key} must be a finite non-negative number`);
    }
  }
}

function validateBrowserInputProof(inputProof: SmokeReport["browser"]["inputProof"], file: string): void {
  if (!inputProof || typeof inputProof !== "object") {
    throw new Error(`${file}: browser.inputProof is required`);
  }
  if (typeof inputProof.snapshotTargetCount !== "number" || inputProof.snapshotTargetCount < 2) {
    throw new Error(`${file}: browser.inputProof.snapshotTargetCount must be at least 2`);
  }
  for (const key of [
    "snapshotIdPresent",
    "screenshotAvailable",
    "moveOk",
    "clickOk",
    "typeOk",
    "keyOk",
    "clicked",
    "submitted",
    "cursorOverlay",
  ] as const) {
    if (inputProof[key] !== true) throw new Error(`${file}: browser.inputProof.${key} must be true`);
  }
  if (typeof inputProof.typedLength !== "number" || inputProof.typedLength <= 0) {
    throw new Error(`${file}: browser.inputProof.typedLength must be positive`);
  }
}

function parseArgs(args: string[]): { dir: string } {
  let dir = "release-smoke-artifacts";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log("usage: pnpm run smoke:desktop:packaged:validate -- [--dir <path>]");
      process.exit(0);
    }
    if (arg === "--dir") {
      dir = args[++index] ?? dir;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
