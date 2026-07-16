import { describe, expect, test } from "vitest";
import type { InsightItem, InsightRun } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { InsightsView } from "../apps/web/src/components/insights/InsightsView";

const noop = () => undefined;
const noopAsync = async () => undefined;

function renderInsights(enabled: boolean, items: InsightItem[] = [], runs: InsightRun[] = []): string {
  return renderToStaticMarkup(
    createElement(InsightsView, {
      enabled,
      items,
      runs,
      nextScanAt: "2026-07-15T18:00:00.000Z",
      scanRunning: false,
      scanStartedAt: null,
      scanning: false,
      savingEnabled: false,
      error: null,
      onEnabledChange: noopAsync,
      onPatchStatus: noopAsync,
      onOpenSession: noop,
    }),
  );
}

describe("InsightsView", () => {
  test("requires users to turn on observation scanning", () => {
    const html = renderInsights(false);

    expect(html).toContain('aria-label="Observation scanning"');
    expect(html).toContain("It stays off until you turn it on.");
    expect(html).toContain(">Turn on</button>");
    expect(html).toContain("Scanning is off");
    expect(html).not.toContain(">Scan</button>");
    expect(html).not.toContain("insights-scan-button");
  });

  test("shows the enabled observation scanning state", () => {
    const html = renderInsights(true);

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('class="active"');
    expect(html).toContain(">On</button>");
    expect(html).not.toContain("Scanning is off");
  });

  test("uses dropdown filters and semantic bordered table shells", () => {
    const html = renderInsights(false, [insightItem(0)], [insightRun(0)]);

    expect(html.match(/<select/g)).toHaveLength(5);
    expect(html).toContain("Observation status");
    expect(html).toContain("Run status");
    expect(html).toContain('<table class="insights-table insights-observations-table">');
    expect(html).toContain('<table class="insights-table insights-runs-table">');
    expect(html).toContain('aria-label="Active pagination"');
    expect(html).toContain('aria-label="Runs pagination"');
    expect(html).not.toContain("insights-segmented");
  });

  test("limits runs and active observations to ten rows per page", () => {
    const html = renderInsights(
      true,
      Array.from({ length: 11 }, (_, index) => insightItem(index)),
      Array.from({ length: 11 }, (_, index) => insightRun(index)),
    );

    expect(html).toContain("Observation 9");
    expect(html).not.toContain("Observation 10");
    expect(html).toContain("Run 9");
    expect(html).not.toContain("Run 10");
    expect(html.match(/1–10 of 11/g)).toHaveLength(2);
    expect(html.match(/Page 1 of 2/g)).toHaveLength(2);
  });
});

function insightItem(index: number): InsightItem {
  return {
    id: `insight-${index}`,
    scopeType: "global",
    scopeId: "default",
    severity: "concern",
    type: "test",
    status: "active",
    fingerprint: `fingerprint-${index}`,
    title: `Observation ${index}`,
    summary: `Observation summary ${index}`,
    payload: { evidenceSource: "create_edit" },
    lastRunId: null,
    lastRunSessionId: null,
    lastRunTurnId: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    resolvedAt: null,
    dismissedAt: null,
  };
}

function insightRun(index: number): InsightRun {
  return {
    id: `run-${index}`,
    sessionId: `session-${index}`,
    turnId: `turn-${index}`,
    trigger: "interval",
    status: "completed",
    startedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:01:00.000Z",
    elapsedMs: 60_000,
    modelRef: null,
    usage: null,
    evidenceSources: ["create_edit"],
    evidenceHash: `evidence-${index}`,
    sourceEventSequence: index,
    findingCount: 1,
    createdCount: 1,
    updatedCount: 0,
    resolvedCount: 0,
    summary: `Run ${index}`,
    error: null,
  };
}
