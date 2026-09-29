import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { createAcceptancePlan } from "../src/learning/acceptance-plan.js";
import {
  acceptanceGroupVerdict, assertAcceptanceBaselineReuse, assertAcceptanceGroupUpdate,
  createAcceptanceGroupManifest, createAcceptanceGroupSnapshot, type AcceptanceAttempt,
} from "../src/learning/acceptance-group.js";

const ref = (id: string) => ({ id, contentHash: contentHash(id) });
const at = "2026-09-29T00:00:00.000Z";
function fixture(id = "acceptance-1") {
  const plan = createAcceptancePlan({
    schemaVersion: "openpond.acceptancePlan.v1", id: "plan", revision: 1, maximumSpendUsd: 2,
    checks: ["quality", "retention"].map(checkId => ({
      id: checkId, name: checkId, role: checkId as "quality" | "retention", unit: "fraction", required: true,
      dataset: ref(`data-${checkId}`), evaluator: ref(`grader-${checkId}`), executionHash: contentHash("runtime"),
      populationHash: contentHash(`population-${checkId}`), metric: "score", direction: "higher" as const,
      minimumCoverage: 1, threshold: 0.8, maximumRegression: 0.01, maximumSpendUsd: 1,
      baselineReuse: { maximumAgeSeconds: 3600, qualification: ref("qualified-runtime") },
    })),
  });
  const manifest = createAcceptanceGroupManifest({
    schemaVersion: "openpond.acceptanceGroupManifest.v1", id, teamId: "team", trainingJob: ref("job"),
    baseline: ref("baseline"), candidate: ref("candidate"), plan, maximumParallelAttempts: 2, createdAt: at,
  });
  const attempts: AcceptanceAttempt[] = plan.checks.flatMap(check => (["baseline", "candidate"] as const).map(subject => ({
    id: `${check.id}-${subject}`, checkId: check.id, subject, ordinal: 1, dispatchId: `dispatch-${check.id}-${subject}`,
    state: "completed", artifact: manifest[subject], checkHash: contentHash(check),
    measurement: {
      runId: `run-${check.id}-${subject}`, artifact: manifest[subject], checkHash: contentHash(check),
      populationHash: check.populationHash, scoredPopulationHash: check.populationHash, executionHash: check.executionHash,
      evaluator: check.evaluator, metric: check.metric, expectedCount: 2, scoredCount: 2, score: 0.9,
      status: "completed", evidenceHash: contentHash(`evidence-${check.id}-${subject}`),
    },
    executionReceipt: ref(`execution-${check.id}-${subject}`), reusedFrom: null, spendUsd: 0.1, reservedUsd: 0,
    cleanupComplete: true, accountingComplete: true, failureCode: null, createdAt: at, updatedAt: at,
  })));
  const snapshot = (values = attempts, state: "completed" | "running" = "completed") => createAcceptanceGroupSnapshot({
    schemaVersion: "openpond.acceptanceGroupSnapshot.v1", manifest, revision: 1, state,
    attempts: values, failureCode: null, updatedAt: at,
  });
  return { manifest, attempts, snapshot };
}

// Failure story: a passing headline cannot bypass another required check,
// unsettled cleanup, the exact candidate, or the total/per-check budget.
it("requires every independent check and settled lifecycle before acceptance", () => {
  const { attempts, snapshot } = fixture();
  expect(acceptanceGroupVerdict(snapshot()).passed).toBe(true);
  expect(acceptanceGroupVerdict(snapshot(attempts.slice(0, 2), "running")).passed).toBe(false);
  const bad = structuredClone(attempts);
  bad[3]!.measurement!.score = 0.1;
  expect(acceptanceGroupVerdict(snapshot(bad)).passed).toBe(false);
  const overspent = structuredClone(attempts);
  overspent[0]!.spendUsd = 1.1;
  expect(acceptanceGroupVerdict(snapshot(overspent)).reasons).toContain("acceptance_budget_exceeded");
  expect(() => snapshot(attempts.map((attempt, index) => index ? attempt : { ...attempt, cleanupComplete: false }))).toThrow();
  expect(() => snapshot(attempts.map((attempt, index) => index ? attempt : { ...attempt, artifact: ref("other-artifact") }))).toThrow();
  expect(() => snapshot([...attempts, attempts[0]!])).toThrow();
});

// Failure story: restart/retry must not rewrite an earlier completed attempt or
// erase its cost; a successful prior group cannot be edited into a new review.
it("retains attempt costs and freezes completed evidence", () => {
  const { manifest, attempts, snapshot } = fixture();
  const previous = snapshot(attempts.map((attempt, index) => index < 2 ? attempt : { ...attempt, state: "grading", measurement: null, executionReceipt: null, cleanupComplete: false, accountingComplete: false }), "running");
  const { contentHash: _hash, ...content } = previous;
  const next = createAcceptanceGroupSnapshot({
    ...content, revision: 2, attempts, state: "completed",
    schemaVersion: "openpond.acceptanceGroupSnapshot.v1", manifest,
  });
  expect(assertAcceptanceGroupUpdate(previous, next).state).toBe("completed");
  expect(() => assertAcceptanceGroupUpdate(next, next)).toThrow();
  const edited = structuredClone(attempts);
  edited[0]!.spendUsd = 0;
  expect(() => assertAcceptanceGroupUpdate(previous, createAcceptanceGroupSnapshot({ ...content, revision: 2, attempts: edited }))).toThrow();
});

// Failure story: an older successful measurement cannot be reused after a
// expiry, workspace switch, or a change in the baseline artifact.
it("reuses only exact fresh qualified baseline evidence", () => {
  const source = fixture(), target = fixture("acceptance-2");
  const reuse = (changes: Partial<Parameters<typeof assertAcceptanceBaselineReuse>[0]> = {}) => assertAcceptanceBaselineReuse({
    sourceGroup: source.snapshot(), targetManifest: target.manifest, checkId: "quality", attemptId: "quality-baseline",
    now: "2026-09-29T00:30:00.000Z", ...changes,
  });
  expect(reuse().measurement?.runId).toBe("run-quality-baseline");
  expect(() => reuse({ now: "2026-09-29T02:00:00.000Z" })).toThrow();
  const { contentHash: _hash, ...content } = target.manifest;
  expect(() => reuse({ targetManifest: createAcceptanceGroupManifest({ ...content, teamId: "another-team" }) })).toThrow();
  expect(() => reuse({ targetManifest: createAcceptanceGroupManifest({ ...content, baseline: ref("different-model") }) })).toThrow();
});

// Failure story: a restarted owner must count a failed attempt's spend when
// reserving its retry and cannot erase history to fit the budget.
it("appends queued retries and includes outstanding reservations in dispatch admission", () => {
  const { attempts, snapshot } = fixture();
  const failed = { ...attempts[0]!, state: "failed" as const, measurement: null, executionReceipt: null, failureCode: "runner_failed", spendUsd: 0.6 };
  const previous = snapshot([failed], "running");
  const retry = { ...failed, id: "retry", dispatchId: "retry-dispatch", ordinal: 2, state: "queued" as const, failureCode: null, spendUsd: 0, cleanupComplete: false, accountingComplete: false };
  const { contentHash: _hash, ...content } = previous;
  const queued = createAcceptanceGroupSnapshot({ ...content, revision: 2, attempts: [failed, retry] });
  expect(assertAcceptanceGroupUpdate(previous, queued)).toEqual(queued);
  const { contentHash: _queuedHash, ...queuedContent } = queued;
  const dispatch = (reservedUsd: number) => createAcceptanceGroupSnapshot({ ...queuedContent, revision: 3, attempts: [failed, { ...retry, state: "dispatching", reservedUsd }] });
  expect(assertAcceptanceGroupUpdate(queued, dispatch(0.3)).attempts).toHaveLength(2);
  expect(() => assertAcceptanceGroupUpdate(queued, dispatch(0.5))).toThrow(/budget/);
  expect(() => assertAcceptanceGroupUpdate(previous, createAcceptanceGroupSnapshot({ ...content, revision: 2, attempts: [{ ...retry, ordinal: 1 }] }))).toThrow(/history/);
});
