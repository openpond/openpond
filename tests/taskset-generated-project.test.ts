import { describe, expect, test } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TasksetSchema } from "../packages/contracts/src";
import { buildTaskset, computeTasksetHash, inspectTaskset } from "../packages/taskset-sdk/src";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("generated Taskset project", () => {
  test("materializes executable environment, fixtures, data, and sandboxed verifier source", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "taskset-project-"));
    try {
      const base = tasksetFixture();
      const custom = TasksetSchema.parse({ ...base, graders: [{ id: "custom", version: "1", label: "Custom verifier", kind: "custom_verifier", weight: 1, hardGate: true, rewardEligible: true, privileged: true, module: "graders/custom.js", exportName: "verify", timeoutMs: 1_000, networkPolicy: "none", metadata: {} }], contentHash: "00000000" });
      const taskset = TasksetSchema.parse({ ...custom, contentHash: computeTasksetHash(custom) });
      const result = await buildTaskset(taskset, directory, { generatedFiles: [{ path: "graders/custom.js", role: "verifier", content: "export function verify({ attempt }) { return { score: attempt.output.text ? 1 : 0, passed: Boolean(attempt.output.text), feedback: 'checked' }; }\n" }] });
      for (const relative of ["taskset.json", "data/tasks.jsonl", "fixtures/grader-fixtures.json", "environment/taskset.ts", "graders/custom.js"]) await access(path.join(directory, relative));
      expect((await inspectTaskset(path.join(directory, "taskset.json"))).report.valid).toBe(true);
      expect(await readFile(path.join(directory, "environment/taskset.ts"), "utf8")).toContain("export const environment");
      expect(result.files.length).toBeGreaterThanOrEqual(7);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
