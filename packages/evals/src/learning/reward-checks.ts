import { z } from "zod";
import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash } from "@openpond/harness";
import { BoundRewardResultSchema, createRewardBinding, executeRewardBinding, type BoundRewardResult, type RewardRelease } from "../rewards.js";
import type { CustomVerifierRunner, ModelJudgeRunner } from "../graders.js";
import { TaskRecordSchema } from "../tasksets.js";
import { LearningJsonObjectSchema, LearningRevisionRefSchema, learningRef } from "./contracts.js";
import { authoringNumber, compileRewardAuthoring, parseRewardAuthoringObject } from "./reward-authoring.js";
import type { AuthoringDraftFor, RewardFixtureAuthoringFields } from "./authoring.js";
import { LearningDomainError } from "./errors.js";
import { JudgeCallReservationSchema } from "./judge-budget.js";

export const RewardFixtureSchema = z.object({
  id: ReleaseIdSchema, name: z.string().trim().min(1).max(500),
  input: LearningJsonObjectSchema, output: LearningJsonObjectSchema,
  expectedOutput: LearningJsonObjectSchema.nullable(), evaluatorContext: LearningJsonObjectSchema.nullable(),
  artifactRefs: z.array(ReleaseIdSchema).max(100), runtimeEventRefs: z.array(ReleaseIdSchema).max(100),
  infrastructureError: z.string().max(20_000).nullable(),
  expected: z.discriminatedUnion("status", [
    z.object({ status: z.literal("scored"), minimum: z.number().finite(), maximum: z.number().finite(), passed: z.boolean().nullable() }).strict(),
    z.object({ status: z.enum(["pending", "unavailable", "failed"]) }).strict(),
  ]),
}).strict().superRefine((fixture, context) => {
  if (fixture.expected.status === "scored" && fixture.expected.minimum > fixture.expected.maximum) context.addIssue({ code: "custom", path: ["expected"], message: "Expected score minimum must not exceed maximum." });
});
export type RewardFixture = z.infer<typeof RewardFixtureSchema>;
export const RewardCheckRuntimeSchema = z.object({ id: ReleaseIdSchema, packageVersion: z.string().min(1).max(100), engine: z.string().min(1).max(200) }).strict();
export type RewardCheckRuntime = z.infer<typeof RewardCheckRuntimeSchema>;
export const RewardFixtureCheckResultSchema = z.object({
  fixture: z.object({ id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict(),
  result: BoundRewardResultSchema, matchesExpectation: z.boolean(),
}).strict();
export type RewardFixtureCheckResult = z.infer<typeof RewardFixtureCheckResultSchema>;
export const RewardCheckRunSchema = z.object({
  schemaVersion: z.literal("openpond.rewardCheckRun.v1"), id: ReleaseIdSchema, revision: z.number().int().positive(),
  draft: LearningRevisionRefSchema, reward: LearningRevisionRefSchema, snapshotHash: ReleaseHashSchema,
  fixtureRefs: z.array(z.object({ id: ReleaseIdSchema, contentHash: ReleaseHashSchema }).strict()).min(1).max(50),
  status: z.enum(["queued", "running", "completed", "failed", "cancelling", "cancelled"]),
  runtime: RewardCheckRuntimeSchema.nullable(), results: z.array(RewardFixtureCheckResultSchema).max(50),
  matchesExpectations: z.boolean().nullable(), failure: z.string().max(20_000).nullable(),
  timeoutMs: z.number().int().min(100).max(300_000), maximumSpendUsd: z.number().nonnegative().max(1_000),
  judgeCalls: z.array(JudgeCallReservationSchema).max(1_000).optional(),
  leaseOwner: ReleaseIdSchema.nullable(), leaseExpiresAt: ReleaseTimestampSchema.nullable(), attemptCount: z.number().int().nonnegative(),
  createdAt: ReleaseTimestampSchema, updatedAt: ReleaseTimestampSchema,
}).strict();
export type RewardCheckRun = z.infer<typeof RewardCheckRunSchema>;

export function compileRewardFixtures(fields: RewardFixtureAuthoringFields[]): RewardFixture[] {
  if (!fields.length || fields.length > 50) throw new LearningDomainError("reward_check_fixtures_required", 422, "Add between one and 50 fixtures before checking this Reward.");
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw new LearningDomainError("reward_fixture_id_duplicate", 422);
  return fields.map(field => RewardFixtureSchema.parse({
    id: field.id, name: field.name,
    input: parseRewardAuthoringObject(field.input, `${field.name}: input`), output: parseRewardAuthoringObject(field.output, `${field.name}: output`),
    expectedOutput: field.expectedOutput.trim() ? parseRewardAuthoringObject(field.expectedOutput, `${field.name}: expected answer`) : null,
    evaluatorContext: field.evaluatorContext.trim() ? parseRewardAuthoringObject(field.evaluatorContext, `${field.name}: evaluator context`) : null,
    artifactRefs: field.artifactRefs.map(value => value.trim()).filter(Boolean), runtimeEventRefs: field.runtimeEventRefs.map(value => value.trim()).filter(Boolean), infrastructureError: field.infrastructureError || null,
    expected: field.expectedStatus === "scored" ? { status: field.expectedStatus, minimum: authoringNumber(field.minimumScore, `${field.name}: minimum score`), maximum: authoringNumber(field.maximumScore, `${field.name}: maximum score`), passed: field.expectedPassed === "any" ? null : field.expectedPassed === "true" } : { status: field.expectedStatus },
  }));
}

export function compileRewardCheck(draft: AuthoringDraftFor<"reward">, base: RewardRelease | null) {
  const compiled = compileRewardAuthoring({ id: draft.targetId, fields: draft.fields, base });
  const fixtures = compileRewardFixtures(draft.fields.fixtures ?? []);
  const fixtureRefs = fixtures.map(fixture => ({ id: fixture.id, contentHash: contentHash(fixture) }));
  return { ...compiled, fixtures, fixtureRefs, snapshotHash: contentHash({ reward: compiled.reward, fixtures }) };
}

/** Fixture data is authored test data, never an owner-recorded production attempt. */
export async function executeRewardFixture(input: {
  reward: RewardRelease; fixture: RewardFixture; signal?: AbortSignal;
  customVerifier?: CustomVerifierRunner; modelJudge?: ModelJudgeRunner;
}): Promise<BoundRewardResult> {
  const fixture = RewardFixtureSchema.parse(input.fixture);
  const task = TaskRecordSchema.parse({
    id: fixture.id, clusterKey: fixture.id, split: "validation", input: fixture.input,
    expectedOutput: fixture.expectedOutput, privilegedContextRef: null,
  });
  const binding = createRewardBinding({
    schemaVersion: "openpond.rewardBinding.v1", id: `fixture-binding-${contentHash(learningRef(input.reward))}`, revision: 1,
    sources: [{ graderId: input.reward.id, reward: learningRef(input.reward), role: "evaluation", normalization: input.reward.rawScore.minimum === 0 && input.reward.rawScore.maximum === 1 ? { kind: "identity" } : { kind: "linear", minimum: input.reward.rawScore.minimum, maximum: input.reward.rawScore.maximum, direction: "higher" }, weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }],
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required",
  }, [input.reward]);
  const composition = await executeRewardBinding({ binding, rewards: [input.reward], task,
    evidence: { output: fixture.output, artifactRefs: fixture.artifactRefs, runtimeEventRefs: fixture.runtimeEventRefs, infrastructureError: fixture.infrastructureError },
    signal: input.signal, customVerifier: input.customVerifier, modelJudge: input.modelJudge, purpose: "fixture_calibration",
  });
  return composition.results[0]!;
}

export function matchRewardFixture(fixture: RewardFixture, result: BoundRewardResult): RewardFixtureCheckResult {
  const expected = fixture.expected;
  const matchesExpectation = result.status === expected.status && (expected.status !== "scored"
    || (result.rawScore !== null && result.rawScore >= expected.minimum && result.rawScore <= expected.maximum && (expected.passed === null || expected.passed === result.passed)));
  return RewardFixtureCheckResultSchema.parse({ fixture: { id: fixture.id, contentHash: contentHash(fixture) }, result, matchesExpectation });
}
