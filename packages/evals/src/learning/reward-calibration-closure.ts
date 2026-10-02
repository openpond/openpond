import { z } from "zod";
import { contentHash, ReleaseHashSchema } from "@openpond/harness";
import { assertRewardHash, composeBoundRewards, createRewardBinding, RewardReleaseSchema } from "../rewards.js";
import { TaskRecordSchema } from "../tasksets.js";
import { assertBoundedTaskJson } from "../task-schema.js";
import { AuthoringDraftSchema } from "./authoring.js";
import { createLearningTextAsset, LearningTextAssetSchema, verifyLearningTextAsset } from "./assets.js";
import { assertLearningContentHash, learningRef, sameLearningRef, type LearningRevisionRef } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { qualifyRewardCheck } from "./reward-calibration.js";
import { compileRewardCheck, matchRewardFixture, RewardCheckRunSchema } from "./reward-checks.js";
import { requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";
export { learningRef, LearningRevisionRefSchema } from "./contracts.js";
export { RewardFixtureSchema } from "./reward-checks.js";

export const MAX_REWARD_CALIBRATION_CLOSURE_BYTES = 524_288;
const ContentSchema = z.object({
  schemaVersion: z.literal("openpond.rewardCalibrationClosure.v1"),
  reward: RewardReleaseSchema,
  draft: AuthoringDraftSchema,
  base: RewardReleaseSchema.nullable(),
  check: RewardCheckRunSchema,
  assets: z.array(LearningTextAssetSchema).min(1).max(100),
}).strict();
export const RewardCalibrationClosureSchema = ContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();
export type RewardCalibrationClosure = z.infer<typeof RewardCalibrationClosureSchema>;

/** Integrity verification of retained owner evidence, not provider attestation
 * or a grant. The host authorizes the source before export and before use. */
export function verifyRewardCalibrationClosure(raw: unknown): RewardCalibrationClosure {
  assertBoundedTaskJson(raw, MAX_REWARD_CALIBRATION_CLOSURE_BYTES);
  const value = RewardCalibrationClosureSchema.parse(raw);
  const { contentHash: hash, ...body } = value;
  if (contentHash(body) !== hash) fail("reward_calibration_closure_changed");
  assertRewardHash(value.reward);
  assertLearningContentHash(value.draft);
  if (value.draft.targetKind !== "reward" || value.draft.targetId !== value.reward.id) fail("reward_calibration_closure_draft_mismatch");
  if (value.base) assertRewardHash(value.base);
  if (value.draft.baseRelease ? !value.base || !sameLearningRef(value.draft.baseRelease, learningRef(value.base)) : value.base !== null)
    fail("reward_calibration_closure_base_mismatch");
  const compiled = compileRewardCheck(value.draft, value.base);
  const { check, reward } = value;
  if (!sameLearningRef(check.draft, learningRef(value.draft)) || !sameLearningRef(check.reward, learningRef(compiled.reward))
    || check.snapshotHash !== compiled.snapshotHash || contentHash(check.fixtureRefs) !== contentHash(compiled.fixtureRefs)
    || check.status !== "completed" || !check.runtime || check.matchesExpectations !== true || check.failure !== null
    || check.results.length !== compiled.fixtures.length) fail("reward_calibration_closure_check_mismatch");
  const expectedReward = qualifyRewardCheck(value.draft, value.base, check).reward;
  // Display fields can be updated by publication; the scoring graph cannot.
  const scoring = (item: typeof reward) => contentHash([item.implementation, item.rawScore, item.assets, item.fixtureSetRef ?? null]);
  if (reward.id !== expectedReward.id || scoring(reward) !== scoring(expectedReward)
    || contentHash(reward.calibrationCheckRef ?? null) !== contentHash(expectedReward.calibrationCheckRef ?? null))
    fail("reward_calibration_closure_reward_mismatch");
  const assets = new Map(value.assets.map(asset => [asset.id, asset]));
  if (assets.size !== value.assets.length || assets.size !== compiled.assets.length) fail("reward_calibration_closure_assets_mismatch");
  for (const expected of compiled.assets) {
    const asset = assets.get(expected.id);
    if (!asset || contentHash(asset) !== contentHash(expected)) fail("reward_calibration_closure_asset_changed");
    verifyLearningTextAsset(asset, expected.asset);
    if (asset.asset.visibility === "policy") fail("reward_calibration_closure_asset_visible");
  }
  if (!reward.fixtureSetRef || !assets.has(reward.fixtureSetRef.id)) fail("reward_calibration_closure_fixtures_missing");
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: `fixture-binding-${contentHash(learningRef(compiled.reward))}`, revision: 1,
    sources: [{ graderId: compiled.reward.id, reward: learningRef(compiled.reward), role: "evaluation", normalization: compiled.reward.rawScore.minimum === 0 && compiled.reward.rawScore.maximum === 1
        ? { kind: "identity" } : { kind: "linear", minimum: compiled.reward.rawScore.minimum, maximum: compiled.reward.rawScore.maximum, direction: "higher" },
      weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }],
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [compiled.reward]);
  for (const fixture of compiled.fixtures) {
    const matches = check.results.filter(result => result.fixture.id === fixture.id);
    const result = matches[0];
    if (matches.length !== 1 || !result || result.fixture.contentHash !== contentHash(fixture)
      || !sameLearningRef(result.result.reward, check.reward) || !result.matchesExpectation || !matchRewardFixture(fixture, result.result).matchesExpectation)
      fail("reward_calibration_closure_fixture_mismatch");
    // Recheck embedded grader hashes and scalar composition without executing it.
    const task = TaskRecordSchema.parse({ id: fixture.id, clusterKey: fixture.id, split: "validation", input: fixture.input,
      expectedOutput: fixture.expectedOutput, privilegedContextRef: null });
    composeBoundRewards({ binding, taskHash: contentHash(task), outputHash: contentHash({ output: fixture.output,
      artifactRefs: fixture.artifactRefs, runtimeEventRefs: fixture.runtimeEventRefs, infrastructureError: fixture.infrastructureError }), results: [result.result] });
  }
  return value;
}

export function createRewardCalibrationClosure(input: z.input<typeof ContentSchema>): RewardCalibrationClosure {
  const body = ContentSchema.parse(input);
  return verifyRewardCalibrationClosure({ ...body, contentHash: contentHash(body) });
}

/** Only call inside an already-authorized source transaction. No qualification
 * is fabricated, replayed, or imported into a different repository scope. */
export async function exportRewardCalibrationClosure(tx: LearningTransaction, input: { reward: LearningRevisionRef; check: LearningRevisionRef }) {
  const reward = await requireLearningRelease(tx, "reward", input.reward);
  const check = await requireLearningResource(tx, "reward_check", input.check.id, input.check.revision);
  if (contentHash(check) !== input.check.contentHash) fail("reward_calibration_closure_check_changed");
  const draft = await requireLearningRelease(tx, "draft", check.draft);
  if (draft.targetKind !== "reward") fail("reward_calibration_closure_draft_mismatch");
  const base = draft.baseRelease ? await requireLearningRelease(tx, "reward", draft.baseRelease) : null;
  const compiled = compileRewardCheck(draft, base);
  const assets = await Promise.all(compiled.assets.map(asset => requireLearningResource(tx, "asset", asset.id, 1)));
  return createRewardCalibrationClosure({ schemaVersion: "openpond.rewardCalibrationClosure.v1", reward, check, draft, base, assets });
}

export function rewardCalibrationClosureAsset(raw: unknown) {
  const value = verifyRewardCalibrationClosure(raw);
  return createLearningTextAsset({ text: JSON.stringify(value), path: `graders/calibration/${value.contentHash}.json`,
    mediaType: "application/vnd.openpond.reward-calibration-closure+json", visibility: "host_private" });
}

function fail(code: string): never { throw new LearningDomainError(code, 422); }
