import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  TasksetReleaseSchema,
  validateTasksetRelease,
  type TasksetRelease,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import { describe, expect, test } from "vitest";

import {
  benchmarkUpstreamModelFromCatalog,
} from "../apps/server/src/training/training-model-runtime.js";

const tasksetDirectory = path.join(
  process.cwd(),
  "benchmarks/harness-refiner/taskset",
);

async function loadTaskset(): Promise<TasksetRelease> {
  return TasksetReleaseSchema.parse(
    JSON.parse(
      await readFile(path.join(tasksetDirectory, "taskset.release.json"), "utf8"),
    ),
  );
}

describe("public Harness Refiner benchmark Taskset", () => {
  test("is a valid content-addressed 10/10 evaluation release", async () => {
    const taskset = await loadTaskset();
    const validation = validateTasksetRelease(taskset);

    expect(validation.issues).toEqual([]);
    expect(taskset.id).toBe("harness-refiner-public-v1");
    expect(taskset.tasks).toHaveLength(20);
    expect(taskset.tasks.filter((task) => task.split === "validation")).toHaveLength(10);
    expect(taskset.tasks.filter((task) => task.split === "frozen_eval")).toHaveLength(10);
    expect(new Set(taskset.tasks.map((task) => task.clusterKey)).size).toBe(20);
    expect(taskset.metadata).toMatchObject({
      trainingSideEffect: false,
      primaryMetric: "paired_foreground_provider_tokens",
      qualityPolicy: "hard_non_regression",
    });
  });

  test("contains ordinary real-world prompts with the neutral ChatGPT case", async () => {
    const taskset = await loadTaskset();
    const prompts = taskset.tasks.map((task) => String(task.input.prompt));

    expect(prompts.filter((prompt) => /ChatGPT/i.test(prompt))).toHaveLength(1);
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(
        /\bRefiner\b|\bHarness\b|\bbenchmark\b|\/workspace|\btool name\b/i,
      );
    }
  });

  test("keeps family coverage balanced across both splits", async () => {
    const taskset = await loadTaskset();
    for (const split of ["validation", "frozen_eval"] as const) {
      const tasks = taskset.tasks.filter((task) => task.split === split);
      expect(tasks.filter((task) => task.tags.includes("artifact-verification"))).toHaveLength(4);
      expect(tasks.filter((task) => task.tags.includes("research-efficiency"))).toHaveLength(4);
      expect(tasks.filter((task) => task.tags.includes("constraint-following"))).toHaveLength(2);
    }
  });

  test("admits every unique case without a smoke subset", async () => {
    const taskset = await loadTaskset();
    expect(new Set(taskset.tasks.map((task) => task.id)).size).toBe(20);
    expect(taskset.tasks.filter((task) => task.split === "validation")).toHaveLength(10);
    expect(taskset.tasks.filter((task) => task.split === "frozen_eval")).toHaveLength(10);
  });

  test("requires a concrete catalog revision for the admitted upstream model", () => {
    expect(benchmarkUpstreamModelFromCatalog(
      { providerId: "openpond", modelId: "openpond-chat" },
      {
        revision: "deepseek-v4-pro-2026-08-09",
        metadata: { billing: { pricing: {
          version: "test-v1",
          source: "provider",
          effectiveAt: "2026-08-09T00:00:00.000Z",
          inputUsdPerMillionTokens: 0.4,
          cachedInputUsdPerMillionTokens: 0.04,
          outputUsdPerMillionTokens: 0.8,
        } } },
      },
    )).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      revision: "deepseek-v4-pro-2026-08-09",
      pricing: {
        version: "test-v1",
        source: "provider",
        effectiveAt: "2026-08-09T00:00:00.000Z",
        inputUsdPerMillionTokens: 0.4,
        cachedInputUsdPerMillionTokens: 0.04,
        outputUsdPerMillionTokens: 0.8,
      },
    });
  });

  test("binds every declared tool schema and immutable asset to its content", async () => {
    const taskset = await loadTaskset();
    expect(taskset.tools.map((tool) => tool.name)).toEqual([
      "work_environment",
      "work_list_files",
      "work_read_file",
      "work_write_file",
      "work_edit_file",
      "work_exec",
      "work_save_output",
      "work_stop",
      "web_search",
      "web_fetch",
    ]);
    for (const tool of taskset.tools) {
      expect(tool.inputSchemaHash).toBe(contentHash(tool.inputSchema));
    }

    const assets = [
      ...taskset.tasks.flatMap((task) => task.artifactRefs),
      ...taskset.graders.flatMap((grader) =>
        grader.kind === "model_judge"
          ? [grader.rubricRef]
          : grader.kind === "custom_verifier"
            ? [grader.verifierRef]
            : [],
      ),
    ];
    for (const asset of assets) {
      const contents = await readFile(path.join(tasksetDirectory, asset.path), "utf8");
      expect(asset.sizeBytes).toBe(Buffer.byteLength(contents));
      expect(asset.contentHash).toBe(contentHash(contents));
    }
  });
});
