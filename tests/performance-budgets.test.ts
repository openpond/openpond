import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createOpenPondServer } from "../apps/server/src/index";
import {
  checkRendererBundleBudgets,
  checkServerRouteBudgets,
  checkStartupBudgets,
  collectServerRouteMetrics,
  collectRendererBundleMetrics,
  type RendererBundleBudgets,
  type ServerRouteBudgets,
} from "../scripts/check-performance-budgets";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openpond-performance-budgets-"));
  tempDirs.push(dir);
  return dir;
}

describe("performance budget helpers", () => {
  test("collects renderer bundle metrics from built web assets", async () => {
    const root = await tempDir();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(
      join(root, "index.html"),
      [
        '<script type="module" src="./assets/index.js"></script>',
        '<link rel="stylesheet" href="/assets/index.css">',
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(root, "assets", "index.js"), "x".repeat(100), "utf8");
    await writeFile(join(root, "assets", "lazy.js"), "x".repeat(200), "utf8");
    await writeFile(join(root, "assets", "index.css"), "x".repeat(50), "utf8");

    const metrics = await collectRendererBundleMetrics(root);

    expect(metrics.totalJsBytes).toBe(300);
    expect(metrics.totalCssBytes).toBe(50);
    expect(metrics.initialAssetBytes).toBe(150);
    expect(metrics.largestAssets[0]).toEqual({ path: "assets/lazy.js", bytes: 200 });
  });

  test("reports warning-only renderer budget overages", async () => {
    const root = await tempDir();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), '<script src="/assets/index.js"></script>', "utf8");
    await writeFile(join(root, "assets", "index.js"), "x".repeat(100), "utf8");
    const metrics = await collectRendererBundleMetrics(root);
    const budgets: RendererBundleBudgets = {
      maxTotalJsBytes: 50,
      maxTotalCssBytes: 10,
      maxInitialAssetBytes: 80,
      maxLargestAssetBytes: 90,
    };

    expect(checkRendererBundleBudgets(metrics, budgets).map((warning) => warning.id)).toEqual([
      "renderer-total-js",
      "renderer-initial-assets",
      "renderer-largest-asset",
    ]);
  });

  test("reports warning-only startup budget overages and probe failures", () => {
    expect(
      checkStartupBudgets(
        {
          ok: true,
          serverReadyMs: 6000,
          healthMs: 900,
          serverUrl: "http://127.0.0.1:1234",
          routes: sampleServerRouteMetrics(),
        },
        { maxServerReadyMs: 5000, maxHealthMs: 750 },
      ).map((warning) => warning.id),
    ).toEqual(["server-ready-ms", "server-health-ms"]);

    expect(
      checkStartupBudgets(
        { ok: false, error: "timeout", serverReadyMs: null, healthMs: null },
        { maxServerReadyMs: 5000, maxHealthMs: 750 },
      ),
    ).toEqual([
      {
        id: "server-startup-probe",
        message: "Server startup probe did not complete: timeout",
        actual: 0,
        threshold: 5000,
        unit: "ms",
      },
    ]);
  });

  test("reports warning-only server route budget overages", () => {
    const budgets: ServerRouteBudgets = {
      maxBootstrapMs: 10,
      maxBootstrapBytes: 100,
      maxWorkspaceDiffMs: 10,
      maxWorkspaceDiffBytes: 100,
      maxEventPageMs: 10,
      maxEventPageBytes: 100,
    };

    expect(
      checkServerRouteBudgets(
        {
          bootstrap: {
            id: "bootstrap",
            label: "Bootstrap",
            path: "/v1/bootstrap",
            ok: true,
            status: 200,
            durationMs: 11,
            responseBytes: 101,
          },
          workspaceDiff: {
            id: "workspace-diff",
            label: "Workspace diff",
            path: "/v1/workspaces/project/diff",
            ok: true,
            status: 200,
            durationMs: 9,
            responseBytes: 99,
          },
          eventPage: {
            id: "event-page",
            label: "Event page",
            path: "/v1/events/page",
            ok: false,
            status: 500,
            durationMs: 1,
            responseBytes: 10,
          },
        },
        budgets,
      ).map((warning) => warning.id),
    ).toEqual(["bootstrap-route-ms", "bootstrap-route-bytes", "event-page-route-status"]);
  });

  test("collects server route metrics from real local routes", async () => {
    const storeDir = await tempDir();
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "route-budget-test",
    });
    try {
      const metrics = await collectServerRouteMetrics({ serverUrl: server.url, token: server.token });

      expect(metrics.bootstrap).toMatchObject({ id: "bootstrap", ok: true, status: 200 });
      expect(metrics.workspaceDiff).toMatchObject({ id: "workspace-diff", ok: true, status: 200 });
      expect(metrics.eventPage).toMatchObject({ id: "event-page", ok: true, status: 200 });
      expect(metrics.eventPage.path).toContain("/v1/events/page?sessionId=");
      expect(metrics.bootstrap.responseBytes).toBeGreaterThan(100);
      expect(metrics.workspaceDiff.responseBytes).toBeGreaterThan(100);
      expect(metrics.eventPage.responseBytes).toBeGreaterThan(100);
    } finally {
      await server.close();
    }
  }, 30_000);
});

function sampleServerRouteMetrics() {
  return {
    bootstrap: {
      id: "bootstrap" as const,
      label: "Bootstrap",
      path: "/v1/bootstrap?ensureProfile=0",
      ok: true,
      status: 200,
      durationMs: 1,
      responseBytes: 100,
    },
    workspaceDiff: {
      id: "workspace-diff" as const,
      label: "Workspace diff",
      path: "/v1/workspaces/project/diff",
      ok: true,
      status: 200,
      durationMs: 1,
      responseBytes: 100,
    },
    eventPage: {
      id: "event-page" as const,
      label: "Event page",
      path: "/v1/events/page?afterSequence=0&limit=25",
      ok: true,
      status: 200,
      durationMs: 1,
      responseBytes: 100,
    },
  };
}
