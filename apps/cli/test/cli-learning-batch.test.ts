import { expect, test } from "vitest";
import { OpenPondLearningClient } from "openpond-sdk/learning";
import { executeLearningCliBatch } from "../src/cli/learning-batch";

// Failure story: a timeout after admission must not retry a mutation, leave
// requests running after exit, or dispatch dependent work after a failed request.
test("batch validates before effects, bounds dispatch and retains partial outcomes without retries", async () => {
  const calls: any[] = [];
  const pending: Array<(response: Response) => void> = [];
  let active = 0;
  let peak = 0;
  const client = new OpenPondLearningClient({ baseUrl: "https://learning.example.test", apiKey: "test-key", scope: "test-team",
    fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      peak = Math.max(peak, ++active);
      try { return await new Promise<Response>(resolve => pending.push(resolve)); }
      finally { active--; }
    },
  });
  const operations = Array.from({ length: 4 }, (_, index) => ({ action: "command", command: {
    action: "cancel_grade", operationId: `cancel-${index}`, gradeId: `grade-${index}`, expectedRevision: index + 1,
  } }));
  await expect(executeLearningCliBatch(client, [...operations, { action: "get", kind: "grade", id: "" }], 2)).rejects.toThrow();
  await expect(executeLearningCliBatch(client, operations, 5)).rejects.toThrow();
  expect(calls).toHaveLength(0);
  let settled = false;
  const running = executeLearningCliBatch(client, operations, 2).then(result => { settled = true; return result; });
  expect(calls.map(item => item.command)).toEqual(operations.slice(0, 2).map(item => item.command));
  pending[0]!(Response.json({ code: "request_timeout", error: "Inspect the original operation before retrying." }, { status: 504 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toHaveLength(2);
  expect(settled).toBe(false);
  pending[1]!(Response.json({ operationId: "cancel-1", resources: [] }));
  const result = await running;
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(result.ok).toBe(false);
  expect(result.results).toMatchObject([
    { index: 0, status: "request_failed", error: { code: "request_timeout", status: 504, retryable: true, requestId: null } },
    { index: 1, status: "completed", result: { operationId: "cancel-1" } },
    { index: 2, status: "not_started" }, { index: 3, status: "not_started" },
  ]);
  expect(calls.every(item => item.scope === "test-team")).toBe(true);
  expect(calls).toHaveLength(2);
});
