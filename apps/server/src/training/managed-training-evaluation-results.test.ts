import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingExecutionRefSchema } from "@openpond/contracts";
import {
  canonicalSha256,
  trainingEvaluationTaskPageHash,
  type TrainingEvaluationTaskPage,
} from "openpond-sdk/training";
import { readManagedTrainingEvaluationTasks } from "./managed-training-evaluation-results.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const storeDir = await mkdtemp(
    path.join(tmpdir(), "managed-evaluation-readback-"),
  );
  directories.push(storeDir);
  const source = {
    taskset: { id: "held-out", revision: 1, contentHash: "a".repeat(64) },
    tasks: [{ id: "task-0" }, { id: "task-1" }, { id: "task-2" }],
  };
  const evaluation = { id: "eval-1", contentHash: "b".repeat(64) };
  const ref = TrainingExecutionRefSchema.parse({
    runId: "job-1",
    adapterId: "sandbox-managed-rl",
    tenantId: "team-1",
    manifestHash: "f".repeat(64),
    providerJobId: "job-1",
    leaseId: null,
    createdAt: "2026-09-09T00:00:00.000Z",
  });
  const evidence = {
    providerRunId: "job-1",
    evaluations: [
      {
        reference: evaluation,
        kind: "candidate" as const,
        policyVersion: 2,
        score: 0,
        threshold: 1,
        passed: false,
      },
    ],
  };
  const fetchPage = vi.fn(
    async (
      _evaluation: typeof evaluation,
      options: { cursor?: string; limit: number },
    ) => {
      const offset = Number(options.cursor ?? 0);
      const tasks = await Promise.all(
        source.tasks
          .slice(offset, offset + options.limit)
          .map(async (task) => ({
            taskId: task.id,
            taskSha256: "d".repeat(64),
            resultSha256: "e".repeat(64),
            input: { instruction: "Invoice total?", context: { quantity: 3 } },
            output: "Original answer\n preserved",
            outputSha256: await canonicalSha256("Original answer\n preserved"),
            score: 0,
            evidence: {
              kind: "worker_command" as const,
              id: `command-${task.id}`,
            },
          })),
      );
      const content = {
        schemaVersion: "openpond.trainingEvaluationTaskPage.v1" as const,
        jobId: ref.runId,
        teamId: ref.tenantId!,
        evaluation,
        kind: "candidate" as const,
        policyVersion: 2,
        taskset: source.taskset,
        panelSha256: "c".repeat(64),
        offset,
        total: source.tasks.length,
        tasks,
        nextCursor:
          offset + tasks.length < source.tasks.length
            ? String(offset + tasks.length)
            : null,
      };
      return {
        ...content,
        contentHash: await trainingEvaluationTaskPageHash(content),
      };
    },
  );
  return {
    storeDir,
    ref,
    evaluationId: evaluation.id,
    evidence,
    source,
    fetchPage,
  };
}

// A completed run must retain its original answers without training, regrading,
// accepting a changed source, or trusting modified report bytes on disk.
describe("retained managed evaluation readback", () => {
  it("verifies and retains each page, then reads it without another network request", async () => {
    const input = await fixture();
    const first = await readManagedTrainingEvaluationTasks({
      ...input,
      options: { limit: 2 },
    });
    const second = await readManagedTrainingEvaluationTasks({
      ...input,
      options: { cursor: first.nextCursor!, limit: 2 },
    });
    expect(
      [...first.tasks, ...second.tasks].map((task) => task.taskId),
    ).toEqual(["task-0", "task-1", "task-2"]);
    input.fetchPage.mockRejectedValue(new Error("offline"));
    expect(
      await readManagedTrainingEvaluationTasks({
        ...input,
        options: { limit: 2 },
      }),
    ).toEqual(first);
    expect(input.fetchPage).toHaveBeenCalledTimes(2);
    expect(first.tasks[0]?.output).toBe("Original answer\n preserved");
    expect(first.tasks[0]?.score).toBe(0);
  });

  it("rejects a cross-run evaluation before fetching and fails closed for changed cached bytes", async () => {
    const input = await fixture();
    await expect(
      readManagedTrainingEvaluationTasks({
        ...input,
        evidence: { ...input.evidence, providerRunId: "other-job" },
      }),
    ).rejects.toThrow("different training run");
    await expect(
      readManagedTrainingEvaluationTasks({
        ...input,
        evaluationId: "unrelated-evaluation",
      }),
    ).rejects.toThrow("no retained reference");
    expect(input.fetchPage).not.toHaveBeenCalled();
    await readManagedTrainingEvaluationTasks(input);
    const directory = path.join(
      input.storeDir,
      "training",
      "evaluation-reports",
    );
    const filename = path.join(directory, (await readdir(directory))[0]!);
    const cached = JSON.parse(
      await readFile(filename, "utf8"),
    ) as TrainingEvaluationTaskPage;
    cached.tasks[0]!.output = "Substituted answer";
    await writeFile(filename, JSON.stringify(cached));
    await expect(readManagedTrainingEvaluationTasks(input)).rejects.toThrow(
      "hash",
    );
    expect(input.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a correctly hashed report for the wrong owner, policy, frozen Taskset, or task ordering", async () => {
    for (const change of [
      (page: TrainingEvaluationTaskPage) => {
        page.teamId = "other-team";
      },
      (page: TrainingEvaluationTaskPage) => {
        page.policyVersion = 3;
      },
      (page: TrainingEvaluationTaskPage) => {
        page.taskset = { ...page.taskset, revision: 2 };
      },
      (page: TrainingEvaluationTaskPage) => {
        page.tasks = [...page.tasks].reverse();
      },
    ]) {
      const input = await fixture();
      const original = input.fetchPage.getMockImplementation()!;
      input.fetchPage.mockImplementation(async (evaluation, options) => {
        const page = await original(evaluation, options);
        change(page);
        page.contentHash = await trainingEvaluationTaskPageHash(page);
        return page;
      });
      await expect(readManagedTrainingEvaluationTasks(input)).rejects.toThrow();
      await expect(
        readdir(path.join(input.storeDir, "training", "evaluation-reports")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
