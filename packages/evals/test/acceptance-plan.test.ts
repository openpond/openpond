import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { createAcceptancePlan, evaluateAcceptancePlan, type AcceptanceMeasurement } from "../src/learning/acceptance-plan.js";

// Failure story: a high headline score must never accept the wrong artifact,
// mixed populations, a missing required check, or an unfinished execution.
it("requires complete comparable evidence for every required acceptance check", () => {
  const ref = (id: string) => ({ id, contentHash: contentHash(id) });
  const baseline = ref("baseline"), candidate = ref("candidate");
  const check = { id: "quality", name: "Quality", required: true, dataset: ref("holdout"), evaluator: ref("grader"), executionHash: contentHash("runtime"), populationHash: contentHash("cases"), metric: "score", direction: "higher" as const, minimumCoverage: 1, threshold: 0.8, maximumRegression: 0.01, maximumSpendUsd: 1 };
  const plan = createAcceptancePlan({ schemaVersion: "openpond.acceptancePlan.v1", id: "plan", revision: 1, checks: [check, { ...check, id: "safety" }], maximumSpendUsd: 2 });
  const measurements = plan.checks.map(c => {
    const measure = (artifact: typeof baseline): AcceptanceMeasurement => ({ artifact, runId: `${c.id}-${artifact.id}`, checkHash: contentHash(c), populationHash: c.populationHash, scoredPopulationHash: c.populationHash, executionHash: c.executionHash, evaluator: c.evaluator, metric: c.metric, expectedCount: 10, scoredCount: 10, score: 0.9, status: "completed", evidenceHash: contentHash(`${c.id}-${artifact.id}`) });
    return { checkId: c.id, baseline: measure(baseline), candidate: measure(candidate) };
  });
  const evaluate = (values = measurements) => evaluateAcceptancePlan({ plan, baseline, candidate, measurements: values });
  expect(evaluate().passed).toBe(true);
  expect(evaluate(measurements.slice(0, 1)).passed).toBe(false);
  for (const replacement of [
    { artifact: baseline }, { status: "running" as const }, { scoredCount: 9 },
    { scoredPopulationHash: contentHash("other cases") }, { evaluator: ref("another grader") },
    { score: 0.1 }, { executionHash: contentHash("other runtime") },
  ]) {
    expect(evaluate(measurements.map((m, i) => i ? m : { ...m, candidate: { ...m.candidate, ...replacement } })).passed).toBe(false);
  }
  expect(() => evaluateAcceptancePlan({ plan: { ...plan, checks: [check] }, baseline, candidate, measurements })).toThrow();
});
