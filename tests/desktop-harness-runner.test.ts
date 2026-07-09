import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { parseDesktopHarnessArgs } from "../scripts/desktop-harness/cli";
import { filterScenarios, loadScenarios, runDesktopHarness } from "../scripts/desktop-harness/runner";
import { desktopScenario } from "../scripts/desktop-harness/scenario";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop harness runner", () => {
  test("parses run options without launching desktop", () => {
    const options = parseDesktopHarnessArgs([
      "run",
      "tests/desktop-scenarios/chat-two-turns.ts",
      "--none",
      "--grep",
      "chat",
      "--app",
      "release/linux-unpacked/openpond",
      "--artifacts-dir",
      "tmp/harness",
      "--json=tmp/harness/report.json",
      "--timeout-ms=1234",
    ]);

    expect(options).toMatchObject({
      scenarioPaths: ["tests/desktop-scenarios/chat-two-turns.ts"],
      launchMode: "none",
      grep: "chat",
      appPath: "release/linux-unpacked/openpond",
      artifactsDir: "tmp/harness",
      jsonPath: "tmp/harness/report.json",
      timeoutMs: 1234,
    });
  });

  test("parses packaged launch mode", () => {
    const options = parseDesktopHarnessArgs([
      "run",
      "tests/desktop-scenarios/chat-two-turns.ts",
      "--packaged",
      "--app=release/linux-unpacked/openpond",
    ]);

    expect(options).toMatchObject({
      launchMode: "packaged",
      appPath: "release/linux-unpacked/openpond",
    });
  });

  test("loads scenario modules and filters by name", async () => {
    const scenarios = await loadScenarios(["tests/fixtures/desktop-harness/pass-scenario.ts"], root);

    expect(scenarios.map((scenario) => scenario.name)).toEqual(["fixture-pass"]);
    expect(filterScenarios(scenarios, "pass").map((scenario) => scenario.name)).toEqual(["fixture-pass"]);
    expect(filterScenarios(scenarios, "missing")).toEqual([]);
  });

  test("loads the subagent desktop scenario suite", async () => {
    const scenarios = await loadScenarios(["tests/desktop-scenarios/subagent-suite.ts"], root);

    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      "subagent-heartbeat-settings",
      "subagent-heartbeat-no-progress-wake",
      "subagent-heartbeat-thread-scoped",
      "subagent-heartbeat-stale",
      "subagent-visible-lifecycle",
      "subagent-running-state",
      "subagent-handoff-parent-wake",
      "subagent-watch-submission-wake",
      "subagent-review-revision-loop",
      "subagent-bounded-worker-contract",
      "subagent-blocked-approval",
      "goal-scoped-subagent-details",
    ]);
  });

  test("writes a successful JSON report with scenario evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-harness-test-"));
    try {
      const jsonPath = path.join(tempDir, "report.json");
      const report = await runDesktopHarness({
        scenarioPaths: ["tests/fixtures/desktop-harness/pass-scenario.ts"],
        launchMode: "none",
        artifactsDir: tempDir,
        jsonPath,
        repoRoot: root,
        now: () => new Date("2026-07-08T12:00:00.000Z"),
      });

      expect(report.ok).toBe(true);
      expect(report.generatedAt).toBe("2026-07-08T12:00:00.000Z");
      expect(report.scenarios[0]).toMatchObject({
        name: "fixture-pass",
        ok: true,
        events: ["turn.started"],
        rendererAssertions: { parentChatVisible: true },
        metadata: { parentSessionId: "session_fixture_parent" },
      });
      const persisted = JSON.parse(await readFile(jsonPath, "utf8"));
      expect(persisted.ok).toBe(true);
      expect(persisted.scenarios[0].name).toBe("fixture-pass");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("captures scenario failures in the report without throwing the whole run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-harness-test-"));
    try {
      const report = await runDesktopHarness({
        scenarioPaths: ["tests/fixtures/desktop-harness/fail-scenario.ts"],
        launchMode: "none",
        artifactsDir: tempDir,
        repoRoot: root,
      });

      expect(report.ok).toBe(false);
      expect(report.scenarios[0]).toMatchObject({
        name: "fixture-fail",
        ok: false,
        events: ["turn.started"],
        rendererAssertions: { parentChatVisible: false },
      });
      expect(report.scenarios[0].error?.message).toBe("intentional fixture failure");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("supports inline scenario definitions for focused unit coverage", async () => {
    const scenario = desktopScenario({
      name: "inline",
      run(harness) {
        harness.recordAssertion("inline", true);
      },
    });

    expect(scenario.name).toBe("inline");
  });
});
