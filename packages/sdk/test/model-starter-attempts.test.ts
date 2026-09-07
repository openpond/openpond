import { expect, it } from "vitest";
import { ModelStarterAttemptRequestSchema, ModelStarterAttemptSummarySchema, OpenPondModelStarterAttemptsClient } from "../src/model-starter-attempts.js";
import { canonicalSha256 } from "../src/protocol.js";
import { sealLearningContent } from "@openpond/evals/learning";
import { verifyModelStarterEnvironmentAttempt } from "../src/model-starters.js";

// A retry must select the same immutable task and policy; neither submitted
// world bytes nor a receipt from another workspace can become execution proof.
it("retains request identity, isolates fixture attribution and verifies returned evidence", async () => {
  const request = ModelStarterAttemptRequestSchema.parse({ schemaVersion: "openpond.modelStarterAttemptRequest.v1", operationId: "operation", teamId: "team", modelProjectId: "model", taskset: { id: "tasks", revision: 1, contentHash: "a".repeat(64) }, taskId: "task", policy: { kind: "fixture", fixtureId: "positive" } });
  const summary = ModelStarterAttemptSummarySchema.parse({ schemaVersion: "openpond.modelStarterAttemptSummary.v1", id: "attempt", revision: 1, request, status: "queued", policySnapshot: null, createdAt: "2026-09-07T00:00:00.000Z", startedAt: null, completedAt: null, cleanupComplete: false, resultAvailable: false, score: null, passed: null, outputPreview: null, error: null });
  let returned: unknown = summary;
  const requests: string[] = [];
  const client = new OpenPondModelStarterAttemptsClient({ baseUrl: "https://host.invalid", apiKey: "test", teamId: "team", fetch: async (url, init) => {
    requests.push(String(url));
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-openpond-team-id")).toBe("team");
    if (init?.body) expect(JSON.parse(String(init.body))).toEqual(request);
    return Response.json(returned);
  } });
  expect(await client.create(request)).toEqual(summary);
  expect(await client.create(request)).toEqual(summary);
  expect(() => ModelStarterAttemptRequestSchema.parse({ ...request, evaluatorContext: { passed: true } })).toThrow();
  expect(() => ModelStarterAttemptSummarySchema.parse({ ...summary, policySnapshot: { modelId: "fake", provider: "fake", upstreamModelId: "fake", configurationHash: "a".repeat(64) } })).toThrow();
  returned = { ...summary, request: { ...request, teamId: "other" } };
  await expect(client.get("attempt")).rejects.toThrow("another identity or workspace");
  returned = { ...summary, request: { ...request, taskId: "other" } };
  await expect(client.create(request)).rejects.toThrow("differs from the submitted request");
  const result = { schemaVersion: "openpond.modelStarterAttemptResult.v1", attempt: { ...summary, revision: 3, status: "completed", cleanupComplete: true, resultAvailable: true, completedAt: summary.createdAt }, output: "done", messages: [], composition: null, environment: { status: "completed", collected: true, definition: request.taskset, initialStateHash: "b".repeat(64), finalStateHash: "b".repeat(64), attemptHash: "c".repeat(64) }, providerRequestIds: [] };
  returned = { ...result, contentHash: await canonicalSha256(result) };
  expect((await client.result("attempt")).output).toBe("done");
  returned = { ...returned as object, output: "forged" };
  await expect(client.result("attempt")).rejects.toThrow("integrity failed");
  expect(requests[0]).toBe("https://host.invalid/v1/model-starter-attempts");
  returned = { modelProjectId: request.modelProjectId, taskset: request.taskset, available: true, unavailableReason: null, tasks: [{ id: "task", split: "train", inputPreview: "Example", fixtures: [{ id: "positive", label: "positive" }] }], models: [], nextCursor: null };
  expect((await client.choices({ modelProjectId: request.modelProjectId, taskset: request.taskset })).tasks).toHaveLength(1);
  returned = { ...returned as object, modelProjectId: "other" };
  await expect(client.choices({ modelProjectId: request.modelProjectId, taskset: request.taskset })).rejects.toThrow("choices differ");
  const input = { id: "A" }; const state = { count: 1 };
  const environment = sealLearningContent({ schemaVersion: "openpond.javascriptEnvironmentAttempt.v1", taskId: "task", status: "completed", output: "done", collected: true, environmentCleanupComplete: true, messages: [], error: null, snapshot: { definition: request.taskset, inputHash: sealLearningContent(input).contentHash, seed: 0, initialStateHash: "b".repeat(64), finalStateHash: sealLearningContent(state).contentHash, state, events: [] } });
  const admitted = { taskId: "task", input, seed: 0, javascript: request.taskset };
  expect(verifyModelStarterEnvironmentAttempt(environment, admitted)).toEqual(environment);
  expect(() => verifyModelStarterEnvironmentAttempt(environment, { ...admitted, seed: 1 })).toThrow("admitted task");
  expect(() => verifyModelStarterEnvironmentAttempt({ ...environment, output: "changed" }, admitted)).toThrow("recorded bytes");
});
