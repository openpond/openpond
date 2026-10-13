import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { genericToolConformance } from "@openpond/evals/conformance";
import { createTasksetRunManifest, tasksetRunMetricPolicy } from "@openpond/evals/metrics";
import { aggregateGraderScores } from "@openpond/evals/graders";
import { GraderSpecSchema } from "@openpond/evals/tasksets";
import { createSignalReport } from "../src/cli/experiments-signal-report";
import { verifySignalPlan } from "../src/cli/experiments-signal-plan";
const seal = <T extends object>(body: T) => ({ ...body, contentHash: contentHash(body) });
const hash = contentHash("synthetic-only");

function fixture(scores: number[]) {
  const original = genericToolConformance.manifest, taskset = genericToolConformance.taskset;
  const spec = GraderSpecSchema.parse({ ...taskset.graders[0], weight: 1, hardGate: false, rewardEligible: true });
  const pins = [{ id: spec.id, version: spec.version, contentHash: contentHash(spec), feedbackKey: "accuracy", release: null }];
  const tasks = ["family-a", "family-b"].map(id => ({ id, family: id, taskHash: hash, inputHash: contentHash({}), contextHash: contentHash({}) }));
  const population = tasks.flatMap(task => ["0", "1", "2", "3"].map(seed => ({ taskId: task.id, seed, fixtureId: null,
    receiptId: `evaluation-${contentHash(["signal", task.id, seed]).slice(0, 32)}` })));
  const source = { profileId: "profile", sourceRevision: "a".repeat(40), harnessRelease: original.harnessRelease,
    catalogHash: hash, definitionId: "check", definitionHash: hash, target: { kind: "profile" }, environmentHash: hash };
  const request = { schemaVersion: "openpond.modelTasksetRunRequest.v1", operationId: "op", teamId: "team", modelProjectId: null,
    name: "Synthetic signal boundary", taskset: { id: taskset.id, revision: 1, contentHash: taskset.contentHash }, population,
    policy: { kind: "hosted_harness", modelId: "model", profileRepositoryId: "repository", source,
      packageHash: hash, modelConfigurationHash: hash, temperature: 0.8, topP: 1, maxOutputTokens: 2048 } };
  const manifest = createTasksetRunManifest({ schemaVersion: "openpond.tasksetRunManifest.v1", id: "signal",
    tasksetRelease: original.tasksetRelease, packageHash: hash, execution: { kind: "harness", harnessRelease: original.harnessRelease },
    policy: { kind: "model", model: { provider: "openpond", model: "model", revision: null, artifactHash: null, tokenizerRevision: null, chatTemplateHash: null }, configurationHash: hash },
    gradingRole: "evaluation", metricPolicy: tasksetRunMetricPolicy(taskset), population, profileEvaluation: source,
    runtimeTarget: { ...original.runtimeTarget, placement: "local" }, limits: { ...original.limits, maximumSpendUsd: 1 }, createdAt: "2026-10-12T00:00:00.000Z", metadata: {} });
  const plan = verifySignalPlan(seal({ schemaVersion: "openpond.experimentSignalPlan.v1", createdAt: "2026-10-12T00:00:00.000Z",
    preparation: { request, manifest, maximumCostUsd: 1, graders: pins }, packageHash: hash, graders: [spec], tasks,
    thresholds: { groupSize: 4, minimumFamilies: 2, minimumInformativeFamilies: 2, minimumSpread: 0.1, minimumScoredFraction: 1 } }));
  const model = { providerId: "openpond", modelId: "model", configurationHash: hash, maxOutputTokens: 2048, temperature: 0.8, topP: 1, messages: [] };
  const snapshot = { configuration: { operationId: "op", request, maximumCostUsd: 1 }, model,
    packageHash: hash, graders: pins, availableGraders: pins };
  const execution = { ...snapshot, configurationHash: contentHash(snapshot), schemaVersion: "openpond.localExperimentExecution.v1",
    location: "local", id: "signal", teamId: "team", ownerActorId: "owner", operationId: "op", kind: "target", executionHash: hash,
    sourceExecution: null, maximumCostUsd: 1, status: "completed", createdAt: "2026-10-12T00:00:01.000Z", completedAt: "2026-10-12T00:00:02.000Z",
    counts: { pending: 0, running: 0, completed: 8, failed: 0, cancelled: 0, unknown: 0 },
    usage: { knownCostUsd: 0.1, costUsd: 0.1, heldUsd: 0, uncertainRequests: 0 }, cleanupComplete: true, error: null };
  const cases = population.map((member, i) => {
    const score = scores[i]!;
    const component = seal({ schemaVersion: "openpond.graderEvidence.v1", graderId: spec.id, graderVersion: spec.version,
      score, passed: score === 1, rewardEligible: true, failureClass: score === 1 ? null : "policy_failure",
      feedback: [], visibleEvidenceRefs: [], privilegedEvidenceRefs: [] });
    const summary = aggregateGraderScores({ graders: [spec], components: [component] as never });
    const grade = seal({ schemaVersion: "openpond.taskGrade.v1", taskHash: hash, evidenceHash: hash,
      graderSetHash: contentHash([spec]), components: [component], ...summary });
    const output = `synthetic output ${score}`;
    return { receiptId: member.receiptId, taskId: member.taskId, seed: member.seed, status: "completed", input: {}, policyVisibleContext: {},
      output, messages: [], error: null,
      grade: seal({ schemaVersion: "openpond.experimentAttemptGrade.v1", selectionHash: contentHash(pins), grades: [grade], ...summary }),
      profileNative: { sessionId: `session-${i}`, turnId: `turn-${i}`, source, profileRef: { source: "local", repositoryId: "repository", profileId: "profile" },
        admissionHash: hash, modelConfigurationHash: hash, traceHash: hash, runtimeEventRefs: [],
        startedAt: execution.createdAt, completedAt: execution.completedAt, outputHash: contentHash(output), partialOutputAvailable: false } };
  });
  return { plan, result: seal({ execution, cases }) };
}

// Failure story: across-prompt differences and omitted failed attempts must not qualify a constant-reward learner.
it("requires within-prompt signal across frozen families and retains every attempt", () => {
  const constant = fixture([0, 0, 0, 0, 1, 1, 1, 1]);
  const blocked = createSignalReport(constant.plan, constant.result);
  expect(blocked.signalObserved).toBe(false);
  expect(blocked.groups.every(group => group.constant)).toBe(true);
  expect(blocked.blockers).toContain("insufficient_within_prompt_signal");
  const varied = fixture([0, 0.2, 0.7, 1, 0, 0.3, 0.6, 1]);
  expect(createSignalReport(varied.plan, varied.result)).toMatchObject({ signalObserved: true, trainingAuthorized: false, runtimeParityVerified: false });
  expect(() => createSignalReport(varied.plan, seal({ execution: varied.result.execution, cases: varied.result.cases.slice(1) }))).toThrow();
  const changed = structuredClone(varied.result);
  changed.cases[0]!.grade.score = 1;
  expect(() => createSignalReport(varied.plan, changed)).toThrow();
  const transplanted = structuredClone(varied.result);
  const { contentHash: oldCriterionHash, ...criterionBody } = transplanted.cases[0]!.grade.grades[0]!;
  transplanted.cases[0]!.grade.grades[0] = seal({ ...criterionBody, taskHash: contentHash("another-prompt") });
  const { contentHash: oldGradeHash, ...gradeBody } = transplanted.cases[0]!.grade;
  transplanted.cases[0]!.grade = seal(gradeBody);
  expect(() => createSignalReport(varied.plan, seal({ execution: transplanted.execution, cases: transplanted.cases }))).toThrow(/another prompt/);
  const duplicated = structuredClone(varied.result);
  duplicated.cases[0] = duplicated.cases[1]!;
  expect(() => createSignalReport(varied.plan, seal({ execution: duplicated.execution, cases: duplicated.cases }))).toThrow(/duplicates/);
  const unknown = structuredClone(varied.result);
  unknown.execution.usage = { knownCostUsd: 0.1, costUsd: null, heldUsd: 0, uncertainRequests: 1 } as never;
  expect(createSignalReport(varied.plan, seal({ execution: unknown.execution, cases: unknown.cases })).blockers).toContain("cost_or_reservations_unsettled");
  const gated = structuredClone(varied.plan);
  gated.graders[0]!.hardGate = true;
  const { contentHash: ignored, ...body } = gated;
  expect(() => verifySignalPlan(seal(body))).toThrow(/no hard gates/);
});
