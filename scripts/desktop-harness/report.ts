import type {
  DesktopHarnessRunReport,
  DesktopHarnessScenarioReport,
} from "./types.js";

export type DesktopHarnessReportInput = {
  path: string;
  report: DesktopHarnessRunReport;
};

export type DesktopHarnessReleaseScenario = {
  name: string;
  ok: boolean;
  mode: string;
  reportPath: string;
  durationMs: number;
  eventLabels: string[];
  eventIds: string[];
  evidenceIds: string[];
  screenshots: string[];
  metadata: Record<string, unknown>;
  error: string | null;
  knownSkip: string | null;
};

export type DesktopHarnessReleaseSummary = {
  ok: boolean;
  generatedAt: string;
  reportCount: number;
  scenarioCount: number;
  passedCount: number;
  failedCount: number;
  knownSkipCount: number;
  artifactRoots: string[];
  scenarios: DesktopHarnessReleaseScenario[];
};

export function summarizeDesktopHarnessReports(
  inputs: DesktopHarnessReportInput[],
  options: { now?: () => Date } = {},
): DesktopHarnessReleaseSummary {
  const scenarios = inputs.flatMap((input) =>
    input.report.scenarios.map((scenario) => releaseScenario(input.path, scenario)),
  );
  const knownSkipCount = scenarios.filter((scenario) => scenario.knownSkip).length;
  const failedCount = scenarios.filter((scenario) => !scenario.ok && !scenario.knownSkip).length;
  const passedCount = scenarios.filter((scenario) => scenario.ok).length;
  return {
    ok: failedCount === 0,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    reportCount: inputs.length,
    scenarioCount: scenarios.length,
    passedCount,
    failedCount,
    knownSkipCount,
    artifactRoots: uniqueStrings(inputs.map((input) => input.report.artifactsDir)),
    scenarios,
  };
}

export function desktopHarnessReleaseMarkdown(summary: DesktopHarnessReleaseSummary): string {
  const lines = [
    "# Desktop Harness Release Proof",
    "",
    `Status: ${summary.ok ? "PASS" : "FAIL"}`,
    `Generated: ${summary.generatedAt}`,
    `Reports: ${summary.reportCount}`,
    `Scenarios: ${summary.scenarioCount} total, ${summary.passedCount} passed, ${summary.failedCount} failed, ${summary.knownSkipCount} known skips`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Status | Events | Evidence IDs | Screenshots |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const scenario of summary.scenarios) {
    lines.push([
      scenario.name,
      scenario.knownSkip ? `SKIP: ${scenario.knownSkip}` : scenario.ok ? "PASS" : "FAIL",
      compactList(scenario.eventLabels),
      compactList(scenario.evidenceIds),
      compactList(scenario.screenshots),
    ].map(markdownCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  if (summary.artifactRoots.length > 0) {
    lines.push("", "## Artifact Roots", "");
    for (const root of summary.artifactRoots) lines.push(`- ${root}`);
  }
  return `${lines.join("\n")}\n`;
}

function releaseScenario(
  reportPath: string,
  scenario: DesktopHarnessScenarioReport,
): DesktopHarnessReleaseScenario {
  const knownSkip = knownSkipReason(scenario);
  return {
    name: scenario.name,
    ok: scenario.ok,
    mode: scenario.mode,
    reportPath,
    durationMs: scenario.durationMs,
    eventLabels: scenario.events,
    eventIds: scenario.eventIds ?? [],
    evidenceIds: uniqueStrings([
      ...(scenario.eventIds ?? []),
      ...metadataEvidenceIds(scenario.metadata),
    ]),
    screenshots: scenario.screenshots,
    metadata: scenario.metadata,
    error: scenario.error?.message ?? null,
    knownSkip,
  };
}

function knownSkipReason(scenario: DesktopHarnessScenarioReport): string | null {
  const value = scenario.metadata.knownSkip ?? scenario.metadata.skipReason;
  if (typeof value === "string" && value.trim()) return value.trim();
  const message = scenario.error?.message ?? "";
  return message.startsWith("SKIP:") ? message.slice("SKIP:".length).trim() : null;
}

function metadataEvidenceIds(metadata: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (!/(^id$|id$|ids$)/i.test(key)) continue;
    if (typeof value === "string" && value.trim()) {
      ids.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) ids.push(item.trim());
      }
    }
  }
  return ids;
}

function compactList(values: string[], limit = 4): string {
  if (values.length === 0) return "";
  const visible = values.slice(0, limit);
  const hidden = values.length - visible.length;
  return hidden > 0 ? `${visible.join("<br>")}<br>+${hidden} more` : visible.join("<br>");
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
