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
});
