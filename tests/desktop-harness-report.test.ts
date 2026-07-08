import { describe, expect, test } from "bun:test";
import type { DesktopHarnessRunReport } from "../scripts/desktop-harness/types";
import {
  desktopHarnessReleaseMarkdown,
  summarizeDesktopHarnessReports,
} from "../scripts/desktop-harness/report";

describe("desktop harness release report", () => {
  test("summarizes scenario status, event ids, screenshots, evidence ids, and known skips", () => {
    const summary = summarizeDesktopHarnessReports(
      [
        {
          path: "/repo/tmp/report.json",
          report: reportFixture(),
        },
      ],
      { now: () => new Date("2026-07-08T12:00:00.000Z") },
    );

    expect(summary).toMatchObject({
      ok: true,
      generatedAt: "2026-07-08T12:00:00.000Z",
      reportCount: 1,
      scenarioCount: 3,
      passedCount: 1,
      failedCount: 0,
      knownSkipCount: 2,
      artifactRoots: ["/repo/tmp/artifacts"],
    });
    expect(summary.scenarios[0]).toMatchObject({
      name: "pass",
      ok: true,
      eventLabels: ["turn.started", "turn.completed"],
      eventIds: ["event_start", "event_done"],
      evidenceIds: ["event_start", "event_done", "session_1", "run_1"],
      screenshots: ["/repo/tmp/artifacts/pass.png"],
    });
    expect(summary.scenarios[1]).toMatchObject({
      name: "known-skip-metadata",
      knownSkip: "packaged mode not enabled",
    });
    expect(summary.scenarios[2]).toMatchObject({
      name: "known-skip-error",
      knownSkip: "live provider key missing",
    });

    const markdown = desktopHarnessReleaseMarkdown(summary);
    expect(markdown).toContain("Status: PASS");
    expect(markdown).toContain("event_start");
    expect(markdown).toContain("/repo/tmp/artifacts/pass.png");
    expect(markdown).toContain("SKIP: packaged mode not enabled");
  });
});

function reportFixture(): DesktopHarnessRunReport {
  return {
    ok: true,
    generatedAt: "2026-07-08T11:00:00.000Z",
    mode: "isolated",
    repoRoot: "/repo",
    artifactsDir: "/repo/tmp/artifacts",
    timings: { totalMs: 123 },
    scenarios: [
      {
        name: "pass",
        ok: true,
        mode: "isolated",
        startedAt: "2026-07-08T11:00:00.000Z",
        completedAt: "2026-07-08T11:00:01.000Z",
        durationMs: 1000,
        events: ["turn.started", "turn.completed"],
        eventIds: ["event_start", "event_done"],
        rendererAssertions: { visible: true },
        metadata: {
          parentSessionId: "session_1",
          runId: "run_1",
        },
        screenshots: ["/repo/tmp/artifacts/pass.png"],
      },
      {
        name: "known-skip-metadata",
        ok: false,
        mode: "isolated",
        startedAt: "2026-07-08T11:00:01.000Z",
        completedAt: "2026-07-08T11:00:02.000Z",
        durationMs: 1000,
        events: [],
        eventIds: [],
        rendererAssertions: {},
        metadata: { knownSkip: "packaged mode not enabled" },
        screenshots: [],
        error: { message: "not run" },
      },
      {
        name: "known-skip-error",
        ok: false,
        mode: "isolated",
        startedAt: "2026-07-08T11:00:02.000Z",
        completedAt: "2026-07-08T11:00:03.000Z",
        durationMs: 1000,
        events: [],
        eventIds: [],
        rendererAssertions: {},
        metadata: {},
        screenshots: [],
        error: { message: "SKIP: live provider key missing" },
      },
    ],
  };
}
