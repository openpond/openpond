import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runTrainingCommand } from "../src/cli/training";

const logs: string[] = [];
const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
  logs.length = 0;
});

describe("training CLI", () => {
  test("prepares, confirms, starts, and watches a saved Model Run", async () => {
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let statusCount = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body,
      });
      if (String(url).endsWith("/prepare")) {
        return jsonResponse({ state: "ready", sideEffectsStarted: false });
      }
      if (String(url).endsWith("/start")) {
        return jsonResponse({ job: { id: "run_123", status: "queued" } }, 202);
      }
      statusCount += 1;
      return jsonResponse({
        runId: "run_123",
        state: statusCount === 1 ? "running" : "succeeded",
      });
    });

    await runTrainingCommand(
      {
        apiBaseUrl: "http://local.test",
        json: "true",
        maxSpend: "0",
        yes: "true",
      },
      ["start", "model_run_123"],
      { request: request as typeof fetch, sleep: async () => undefined },
    );

    expect(requests.map((item) => item.url)).toEqual([
      "http://local.test/v1/training/model-runs/model_run_123/prepare",
      "http://local.test/v1/training/model-runs/model_run_123/start",
      "http://local.test/v1/training/model-runs/run_123/status",
      "http://local.test/v1/training/model-runs/run_123/status",
    ]);
    expect(requests[0]?.body).toEqual({
      maximumSpendUsd: 0,
      retentionDays: null,
    });
    expect(logs.some((line) => line.includes('"state":"succeeded"'))).toBe(true);
  });

  test("submits an exact manifest and can detach", async () => {
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-training-cli-"),
    );
    const manifestPath = path.join(directory, "manifest.json");
    try {
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: "test" }));
      const bodies: unknown[] = [];
      const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return String(url).endsWith("/prepare")
          ? jsonResponse({ state: "ready" })
          : jsonResponse({ job: { id: "run_detached" } }, 202);
      });

      await runTrainingCommand(
        {
          apiBaseUrl: "http://local.test",
          detach: "true",
          manifest: manifestPath,
          yes: "true",
        },
        ["start", "model_run_manifest"],
        { request: request as typeof fetch },
      );

      expect(bodies[1]).toEqual({
        maximumSpendUsd: null,
        retentionDays: null,
        manifest: { schemaVersion: "test" },
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("requires explicit approval in non-interactive execution", async () => {
    const request = vi.fn(async () => jsonResponse({ state: "ready" }));
    await expect(
      runTrainingCommand(
        { apiBaseUrl: "http://local.test" },
        ["start", "model_run_123"],
        { request: request as typeof fetch },
      ),
    ).rejects.toThrow("requires --yes");
  });

});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
