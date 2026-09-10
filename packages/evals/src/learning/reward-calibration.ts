import { contentHash } from "@openpond/harness";
import { createRewardRelease, type RewardRelease } from "../rewards.js";
import type { AuthoringDraftFor } from "./authoring.js";
import { learningRef, sameLearningRef } from "./contracts.js";
import { LearningDomainError } from "./errors.js";
import { requireLearningRelease, requireLearningResource, type LearningTransaction } from "./repository.js";
import { compileRewardCheck, matchRewardFixture, type RewardCheckRun } from "./reward-checks.js";

/** Qualification is tied to the exact private draft, fixtures and worker-owned
 * provider receipts. Publishing does not rewrite or re-run those checks. */
export function qualifyRewardCheck(draft: AuthoringDraftFor<"reward">, base: RewardRelease | null, check: RewardCheckRun) {
  const compiled = compileRewardCheck(draft, base);
  const implementation = compiled.reward.implementation;
  if (implementation.kind !== "model_judge" || !implementation.model) throw new LearningDomainError("reward_calibration_model_required", 422);
  if (!sameLearningRef(check.draft, learningRef(draft)) || !sameLearningRef(check.reward, learningRef(compiled.reward))
    || check.snapshotHash !== compiled.snapshotHash || contentHash(check.fixtureRefs) !== contentHash(compiled.fixtureRefs)) throw new LearningDomainError("reward_calibration_snapshot_mismatch", 422);
  if (check.status !== "completed" || !check.runtime || check.matchesExpectations !== true || check.failure
    || check.results.length !== compiled.fixtures.length) throw new LearningDomainError("reward_calibration_check_incomplete", 422);
  if (!compiled.fixtures.some(fixture => fixture.expected.status === "scored" && fixture.expected.passed === true)
    || !compiled.fixtures.some(fixture => fixture.expected.status === "scored" && fixture.expected.passed === false)) {
    throw new LearningDomainError("reward_calibration_coverage_required", 422, "Check both a passing and a failing example before publishing a calibrated judge.");
  }
  for (const fixture of compiled.fixtures) {
    const results = check.results.filter(result => result.fixture.id === fixture.id);
    const retained = results[0];
    if (results.length !== 1 || !retained || retained.fixture.contentHash !== contentHash(fixture)
      || !sameLearningRef(retained.result.reward, check.reward) || !matchRewardFixture(fixture, retained.result).matchesExpectation) throw new LearningDomainError("reward_calibration_fixture_mismatch", 422);
    if (fixture.expected.status !== "scored") continue;
    const receipt = retained.result.graderEvidence?.modelJudgeReceipt;
    const call = check.judgeCalls?.find(call => call.id === `fixture-${contentHash([fixture, compiled.reward.contentHash])}`);
    if (!receipt || receipt.providerId !== implementation.model.providerId || receipt.modelId !== implementation.model.modelId
      || (implementation.model.revision !== null && receipt.modelRevision !== implementation.model.revision)
      || call?.status !== "settled" || !call.response || call.requestHash !== receipt.requestHash
      || contentHash(call.response) !== receipt.responseHash) throw new LearningDomainError("reward_calibration_provider_receipt_mismatch", 422);
  }
  const { contentHash: _hash, ...content } = compiled.reward;
  return { ...compiled, reward: createRewardRelease({ ...content, implementation: { ...implementation, calibrationStatus: "passed" },
    calibrationCheckRef: { id: check.id, revision: check.revision, contentHash: contentHash(check) } }) };
}

/** Generic publication cannot manufacture a passed flag, including by copying
 * a check from a different rubric, model, temperature or fixture set. */
export async function assertRewardCalibration(tx: LearningTransaction, reward: RewardRelease) {
  if (reward.implementation.kind !== "model_judge" || reward.implementation.calibrationStatus !== "passed") {
    if (reward.calibrationCheckRef) throw new LearningDomainError("reward_calibration_reference_invalid", 422);
    return;
  }
  const reference = reward.calibrationCheckRef;
  if (!reference) throw new LearningDomainError("reward_calibration_check_required", 422);
  const check = await requireLearningResource(tx, "reward_check", reference.id, reference.revision);
  if (contentHash(check) !== reference.contentHash) throw new LearningDomainError("reward_calibration_check_changed", 422);
  const draft = await requireLearningRelease(tx, "draft", check.draft);
  if (draft.targetKind !== "reward") throw new LearningDomainError("reward_calibration_draft_kind_invalid", 422);
  const base = draft.baseRelease ? await requireLearningRelease(tx, "reward", draft.baseRelease) : null;
  const qualified = qualifyRewardCheck(draft, base, check).reward;
  const scoring = (value: RewardRelease) => contentHash([value.implementation, value.rawScore, value.assets, value.fixtureSetRef ?? null]);
  if (reward.id !== qualified.id || scoring(reward) !== scoring(qualified)) throw new LearningDomainError("reward_calibration_configuration_changed", 422);
}
