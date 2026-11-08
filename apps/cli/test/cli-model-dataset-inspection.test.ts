import { expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/common/args";
import { runCliCommand } from "../src/cli/command-registry";
vi.mock("../src/cli/training", () => ({ DEFAULT_LOCAL_TRAINING_API_URL: "http://127.0.0.1:17874", createLocalAuthenticatedRequest: async () => fetch }));

// Failure story: missing parser options made the advertised inspection command
// unusable. Dumping a model's entire state also exposes held-out rows to chat.
// Exercise argv through transport to the filtered, exact-revision CLI output.
test("model dataset CLI inspects exact pins and bounded splits without dumping held-out rows", async () => {
  const input = { sources: [{ role: "training", name: "Dataset", taskset: { id: "tasks", profileId: "profile", name: "Dataset", revision: 3, contentHash: "a".repeat(64),
    tasks: [{ id: "train-1", split: "train", input: "train-one" }, { id: "train-2", split: "train", input: "train-two" }, { id: "held-out", split: "frozen_eval", input: "hidden-case" }], graders: [{ id: "grader", kind: "content", version: "1", config: { criterion: "correct" } }] } }] };
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("http://127.0.0.1:17874/v1/local-datasets");
    expect(JSON.parse(String(init?.body))).toMatchObject({ action: "context_inputs", payload: { target: { kind: "model", id: "model", location: "local" } } });
    return new Response(JSON.stringify(input));
  });
  async function inspect(...args: string[]) {
    expect(await runCliCommand(parseArgs(["datasets", "model-inputs", "model", "--local", "--json", ...args]))).toBe(true);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  }
  try {
    const summary = await inspect();
    expect(summary.sources[0]).toMatchObject({ taskset: { id: "tasks", revision: 3, taskCount: 3, splits: { train: 2, frozen_eval: 1 } } });
    expect(JSON.stringify(summary)).not.toContain("hidden-case");
    const rows = await inspect("--view", "tasks", "--role", "training", "--split", "train", "--limit", "1");
    expect(rows.sources[0]).toMatchObject({ taskset: { tasks: [input.sources[0]!.taskset.tasks[0]], page: { total: 2, hasMore: true } } });
    expect(JSON.stringify(rows)).not.toContain("hidden-case");
    await expect(inspect("--view", "tasks", "--task-id", "held-out")).rejects.toThrow("split");
    expect((await inspect("--view", "graders")).sources[0]).toMatchObject({ taskset: { graders: input.sources[0]!.taskset.graders } });
    expect(request).toHaveBeenCalledTimes(4);
  } finally { vi.restoreAllMocks(); }
});
