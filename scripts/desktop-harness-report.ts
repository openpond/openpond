import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopHarnessRunReport } from "./desktop-harness/types.js";
import {
  desktopHarnessReleaseMarkdown,
  summarizeDesktopHarnessReports,
} from "./desktop-harness/report.js";

type ReportCliOptions = {
  reportPaths: string[];
  jsonPath: string | null;
  markdownPath: string | null;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const reports = await Promise.all(options.reportPaths.map(async (reportPath) => ({
    path: path.resolve(reportPath),
    report: JSON.parse(await readFile(path.resolve(reportPath), "utf8")) as DesktopHarnessRunReport,
  })));
  const summary = summarizeDesktopHarnessReports(reports);
  if (options.jsonPath) {
    await writeOutputFile(options.jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (options.markdownPath) {
    await writeOutputFile(options.markdownPath, desktopHarnessReleaseMarkdown(summary));
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

function parseArgs(argv: string[]): ReportCliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    throw new ReportHelpRequested();
  }
  const command = argv[0];
  if (command !== "summarize") throw new Error(reportUsage());
  const reportPaths: string[] = [];
  let jsonPath: string | null = null;
  let markdownPath: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      jsonPath = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--json=")) {
      jsonPath = arg.slice("--json=".length);
      continue;
    }
    if (arg === "--markdown") {
      markdownPath = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      markdownPath = arg.slice("--markdown=".length);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown desktop harness report option: ${arg}`);
    reportPaths.push(arg);
  }
  if (reportPaths.length === 0) throw new Error("At least one harness report path is required.");
  return { reportPaths, jsonPath, markdownPath };
}

async function writeOutputFile(filePath: string, contents: string): Promise<void> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, contents);
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

function reportUsage(): string {
  return [
    "usage: bun scripts/desktop-harness-report.ts summarize <report.json...> [options]",
    "",
    "Options:",
    "  --json <path>       Write machine-readable release proof summary.",
    "  --markdown <path>   Write Markdown release proof summary.",
  ].join("\n");
}

class ReportHelpRequested extends Error {
  constructor() {
    super(reportUsage());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    if (error instanceof ReportHelpRequested) {
      console.log(reportUsage());
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
