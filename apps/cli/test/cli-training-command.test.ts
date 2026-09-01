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
  test("creates a persisted managed Model Project from a published Taskset", async () => {
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-managed-project-cli-"),
    );
    const recipePath = path.join(directory, "recipe.json");
    await writeFile(recipePath, JSON.stringify({
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: {
        id: "Qwen/Qwen3-8B",
        revision: "base-revision",
        tokenizerRevision: "tokenizer-revision",
        chatTemplateHash: "a".repeat(64),
      },
    }));
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: String(url), method: init?.method ?? "GET", body });
      if (String(url) === "http://local.test/v1/training") {
        return jsonResponse({
          tasksets: [{
            id: "agent-trajectory",
            profileId: "team-a",
            revision: 2,
            contentHash: "a".repeat(64),
            name: "Agent trajectory",
            objective: "Resolve agent-trajectory issues safely.",
          }],
          modelProjects: [],
        });
      }
      if (String(url) === "http://local.test/v1/training/models") {
        return jsonResponse({ id: "agent-trajectory-model", revision: 1 });
      }
      return jsonResponse({
        id: "agent-trajectory-model",
        revision: 2,
        trainingSetup: { baseModel: { modelId: "Qwen/Qwen3-8B" } },
      });
    });
    try {
      await runTrainingCommand(
        {
          apiBaseUrl: "http://local.test",
          json: "true",
          projectId: "agent-trajectory-model",
          recipe: recipePath,
          rolloutPlacement: "local",
          gpuPlacementObjective: "economical",
          maxSpend: "8",
        },
        ["create-project", "agent-trajectory"],
        { request: request as typeof fetch },
      );
    } finally {
      await rm(directory, { recursive: true });
    }
    expect(requests.map((item) => `${item.method} ${item.url}`)).toEqual([
      "GET http://local.test/v1/training",
      "PUT http://local.test/v1/training/models",
    ]);
    expect(requests[1]?.body).toMatchObject({
      id: "agent-trajectory-model",
      profileId: "team-a",
      defaultDestinationId: "openpond_managed",
      trainingSetup: {
        tasksetRef: {
          id: "agent-trajectory",
          revision: 2,
          contentHash: "a".repeat(64),
        },
        baseModel: {
          modelId: "Qwen/Qwen3-8B",
          revision: "base-revision",
          tokenizerRevision: "tokenizer-revision",
          chatTemplateHash: "a".repeat(64),
          source: "managed",
        },
        method: "grpo",
        destinationId: "openpond_managed",
        managedRolloutPlacement: "local",
        managedGpuPlacementObjective: "economical",
        preferredMaximumSpendUsd: 8,
      },
    });
  });

  test("prepares, confirms, starts, and watches a saved Model Project run", async () => {
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
      ["start", "model_project_123"],
      { request: request as typeof fetch, sleep: async () => undefined },
    );

    expect(requests.map((item) => item.url)).toEqual([
      "http://local.test/v1/training/model-projects/model_project_123/training/prepare",
      "http://local.test/v1/training/model-projects/model_project_123/training/start",
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
      path.join(os.tmpdir(), "openpond-model-improvement-cli-"),
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
          comparisonSeriesEntry: "comparison_entry_p0",
          manifest: manifestPath,
          yes: "true",
        },
        ["start", "model_run_manifest"],
        { request: request as typeof fetch },
      );

      expect(bodies[1]).toEqual({
        exportApproved: false,
        maximumSpendUsd: null,
        retentionDays: null,
        manifest: { schemaVersion: "test" },
        comparisonSeriesEntryId: "comparison_entry_p0",
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

  test("starts and watches the canonical Harness Refiner evaluation run", async () => {
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    const requests: Array<{ url: string; body: unknown }> = [];
    let statusCount = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(url) === "http://local.test/v1/training") {
        return jsonResponse({
          modelProjects: [{ id: "model_1", profileId: "personal" }],
        });
      }
      if (String(url).endsWith("/harness-refiner-benchmark")) {
        return jsonResponse({ id: "model_run_eval_1", status: "running" }, 202);
      }
      statusCount += 1;
      return jsonResponse({
        runId: "model_run_eval_1",
        state: statusCount === 1 ? "running" : "succeeded",
      });
    });

    await runTrainingCommand(
      {
        apiBaseUrl: "http://local.test",
        json: "true",
        model: "openpond-chat",
        provider: "openpond",
        reasoningEffort: "high",
        maxSpend: "2",
      },
      ["benchmark", "model_1"],
      { request: request as typeof fetch, sleep: async () => undefined },
    );

    expect(requests[1]).toEqual({
      url: "http://local.test/v1/training/models/model_1/harness-refiner-benchmark",
      body: {
        profileId: "personal",
        model: { providerId: "openpond", modelId: "openpond-chat" },
        reasoningEffort: "high",
        maximumSpendUsd: 2,
      },
    });
    expect(requests.at(-1)?.url).toContain("model_run_eval_1/status");
  });

  test("rejects detached Harness Refiner runs before starting provider work", async () => {
    const request = vi.fn(async () => jsonResponse({
      modelProjects: [{ id: "model_1", profileId: "personal" }],
    }));

    await expect(runTrainingCommand(
      { apiBaseUrl: "http://local.test", detach: "true" },
      ["benchmark", "model_1"],
      { request: request as typeof fetch },
    )).rejects.toThrow("must be watched to terminal state");

    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toBe("http://local.test/v1/training");
  });

  test("resumes and watches a checkpointed Harness Refiner evaluation", async () => {
    const requests: string[] = [];
    let statusCount = 0;
    const request = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).endsWith("/resume")) {
        return jsonResponse({ id: "model_run_eval_1", status: "running" });
      }
      statusCount += 1;
      return jsonResponse({
        runId: "model_run_eval_1",
        state: statusCount === 1 ? "running" : "succeeded",
      });
    });

    await runTrainingCommand(
      { apiBaseUrl: "http://local.test", json: "true" },
      ["resume", "model_run_eval_1"],
      { request: request as typeof fetch, sleep: async () => undefined },
    );

    expect(requests).toEqual([
      "http://local.test/v1/training/model-runs/model_run_eval_1/resume",
      "http://local.test/v1/training/model-runs/model_run_eval_1/status",
      "http://local.test/v1/training/model-runs/model_run_eval_1/status",
    ]);
  });

});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
