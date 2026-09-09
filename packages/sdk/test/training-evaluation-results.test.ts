import { expect, it } from "vitest";
import {
  TrainingEvaluationTaskPageSchema,
  canonicalSha256,
  createTrainingClient,
  parseAndVerifyTrainingEvaluationTaskPage,
  trainingEvaluationTaskPageHash,
  type TrainingEvaluationTaskPage,
} from "../src/training.js";

async function page(overrides: Partial<TrainingEvaluationTaskPage> = {}) {
  const output = '{"route":"billing"}';
  const value = {
    schemaVersion: "openpond.trainingEvaluationTaskPage.v1" as const,
    jobId: "job-1",
    teamId: "team-1",
    evaluation: { id: "evaluation-1", contentHash: "a".repeat(64) },
    kind: "baseline" as const,
    policyVersion: 0,
    taskset: { id: "held-out", revision: 2, contentHash: "b".repeat(64) },
    panelSha256: "c".repeat(64),
    offset: 0,
    total: 2,
    tasks: [{
      taskId: "task-1", taskSha256: "d".repeat(64), resultSha256: "e".repeat(64),
      input: { instruction: "Route this invoice request", context: {} },
      output, outputSha256: await canonicalSha256(output), score: 1,
      evidence: { kind: "worker_command" as const, id: "command-1" },
    }],
    nextCursor: "1",
    ...overrides,
  };
  return { ...value, contentHash: await trainingEvaluationTaskPageHash(value) };
}

// A client must not adopt another run's evidence, tampered outputs, or a repeated page.
it("verifies paged evaluation evidence against the requested immutable evaluation", async () => {
  const first = await page();
  const second = await page({ offset: 1, nextCursor: null,
    tasks: [{ ...first.tasks[0]!, taskId: "task-2", evidence: { kind: "worker_command", id: "command-2" } }] });
  const paths: string[] = [];
  const client = createTrainingClient({ baseUrl: "https://example.test", fetch: (async (url) => {
    paths.push(String(url));
    return new Response(JSON.stringify(paths.length === 1 ? first : second));
  }) as typeof fetch });
  expect(await client.evaluationTasks(first.jobId, first.evaluation, { limit: 1 })).toEqual(first);
  expect(await client.evaluationTasks(first.jobId, first.evaluation, { cursor: first.nextCursor!, limit: 1 })).toEqual(second);
  expect(paths).toEqual([
    "https://example.test/v1/training/jobs/job-1/evaluations/evaluation-1/tasks?limit=1",
    "https://example.test/v1/training/jobs/job-1/evaluations/evaluation-1/tasks?cursor=1&limit=1",
  ]);
  const expected = { jobId: first.jobId, evaluation: first.evaluation, teamId: first.teamId };
  for (const changed of [
    await page({ jobId: "another-job" }),
    await page({ teamId: "another-team" }),
    await page({ evaluation: { ...first.evaluation, contentHash: "f".repeat(64) } }),
    second,
    { ...first, tasks: [{ ...first.tasks[0], output: "changed" }] },
    await page({ tasks: [{ ...first.tasks[0]!, output: "changed" }] }),
  ]) await expect(parseAndVerifyTrainingEvaluationTaskPage(changed, expected)).rejects.toThrow();
  expect(() => TrainingEvaluationTaskPageSchema.parse({ ...first, tasks: [...first.tasks, ...first.tasks], nextCursor: null })).toThrow();
  expect(() => TrainingEvaluationTaskPageSchema.parse({ ...first, nextCursor: "2" })).toThrow();
  expect(() => TrainingEvaluationTaskPageSchema.parse({ ...first, tasks: [{ ...first.tasks[0], trainingSample: {} }] })).toThrow();
});
