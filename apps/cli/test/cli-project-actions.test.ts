import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runProjectActionsCommand } from "../src/cli/actions-command";

const projectRoot = path.resolve(import.meta.dirname, "../../../examples/project-actions-analytics");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Project Actions CLI", () => {
  test("checks and builds the permanent proof Project", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => logs.push(String(value ?? "")));

    await runProjectActionsCommand({ cwd: projectRoot, json: true }, ["check"]);

    const payload = JSON.parse(logs.join("\n")) as {
      status: string;
      actionCount: number;
      manifest: { sourceDirectory: string; bundleHash: string };
    };
    expect(payload).toMatchObject({
      status: "passed",
      actionCount: 1,
      manifest: { sourceDirectory: "openpond/actions" },
    });
    expect(payload.manifest.bundleHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("runs a built action and returns the typed result", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => logs.push(String(value ?? "")));

    await runProjectActionsCommand({
      cwd: projectRoot,
      input: JSON.stringify({ businessId: "relocation" }),
    }, ["run", "analytics.get_summary"]);

    expect(JSON.parse(logs.join("\n"))).toEqual(expect.objectContaining({
      actionId: "analytics.get_summary",
      status: "succeeded",
      output: {
        businessId: "relocation",
        activeMoves: 42,
        bookedRevenueUsd: 128_500,
      },
    }));
  });

  test("publishes a built action release from the current Git commit", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => logs.push(String(value ?? "")));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      release: {
        id: "release_1",
        projectId: "project_1",
        sourceCommitSha: "abc1234",
        bundleHash: "bundle_hash",
        registryHash: "registry_hash",
        status: "ready",
        createdAt: new Date().toISOString(),
      },
    }, { status: 201 }));
    await runProjectActionsCommand({
      cwd: projectRoot,
      apiKey: "opk_test",
      baseUrl: "https://api.example.test",
      projectId: "project_1",
      teamId: "team_1",
      sourceCommitSha: "abc1234",
      sourceRef: "main",
    }, ["publish"]);

    expect(logs.at(-1)).toBe("Published Project Actions release release_1 from abc1234.");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
