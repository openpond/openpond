import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { createAcceptanceGroupManifest, createAcceptanceGroupSnapshot, createAcceptancePlan } from "@openpond/evals/learning";
import { createTrainingClient } from "../src/training.js";

// Failure story: a server/caching error must not show another team's group or
// substitute a current revision when a caller requested retained review evidence.
it("reads paginated acceptance evidence and rejects changed scope or retained identity", async () => {
  const ref = (id: string) => ({ id, contentHash: contentHash(id) });
  const createdAt = "2026-09-29T00:00:00.000Z";
  const manifest = createAcceptanceGroupManifest({
    schemaVersion: "openpond.acceptanceGroupManifest.v1", id: "group", teamId: "team", trainingJob: ref("job"),
    baseline: ref("baseline"), candidate: ref("candidate"), maximumParallelAttempts: 1, createdAt,
    plan: createAcceptancePlan({
      schemaVersion: "openpond.acceptancePlan.v1", id: "plan", revision: 1, maximumSpendUsd: 1,
      checks: [{ id: "quality", name: "Quality", required: true, role: "quality", unit: "fraction",
        dataset: ref("data"), evaluator: ref("grader"), executionHash: contentHash("runtime"), populationHash: contentHash("panel"),
        metric: "score", direction: "higher", minimumCoverage: 1, threshold: 0.8, maximumRegression: 0, maximumSpendUsd: 1 }],
    }),
  });
  const snapshot = createAcceptanceGroupSnapshot({ schemaVersion: "openpond.acceptanceGroupSnapshot.v1", manifest, revision: 1, state: "queued", attempts: [], failureCode: null, updatedAt: createdAt });
  const summary = { id: manifest.id, revision: 1, contentHash: snapshot.contentHash, teamId: "team", jobId: "job",
    plan: { id: manifest.plan.id, contentHash: manifest.plan.contentHash }, baseline: manifest.baseline, candidate: manifest.candidate, state: snapshot.state, updatedAt: createdAt };
  let response: unknown = { schemaVersion: "openpond.trainingAcceptanceGroupPage.v1", teamId: "team", jobId: "job", groups: [summary], nextCursor: "group" };
  const paths: string[] = [];
  const client = createTrainingClient({ baseUrl: "https://example.test", fetch: (async (url: RequestInfo | URL) => {
    paths.push(String(url)); return Response.json(response);
  }) as typeof fetch });
  const target = { teamId: "team", jobId: "job" };
  expect((await client.acceptanceGroups(target, { limit: 1 })).nextCursor).toBe("group");
  expect(paths.at(-1)).toContain("/v1/training/jobs/job/acceptance-groups?limit=1");
  response = { schemaVersion: "openpond.trainingAcceptanceGroupPage.v1", teamId: "team", jobId: "job", groups: [{ ...summary, teamId: "other-team" }], nextCursor: null };
  await expect(client.acceptanceGroups(target)).rejects.toThrow("workspace");
  response = snapshot;
  expect((await client.acceptanceGroup(target, "group", summary)).revision).toBe(1);
  expect(paths.at(-1)).toContain("/acceptance-groups/group?revision=1");
  await expect(client.acceptanceGroup({ ...target, jobId: "another-job" }, "group")).rejects.toThrow("workspace");
  await expect(client.acceptanceGroup(target, "group", { ...summary, contentHash: contentHash("changed") })).rejects.toThrow("retained revision");
  response = { ...snapshot, state: "completed" };
  await expect(client.acceptanceGroup(target, "group")).rejects.toThrow();
});
