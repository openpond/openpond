import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import { AuthoringDraftSchema } from "../src/learning/authoring.js";
import { sealLearningContent, learningRef } from "../src/learning/contracts.js";
import { rewardAuthoringFields } from "../src/learning/reward-authoring.js";
import { compileRewardCheck, executeRewardFixture, matchRewardFixture, RewardCheckRunSchema } from "../src/learning/reward-checks.js";
import { qualifyRewardCheck } from "../src/learning/reward-calibration.js";
import { createRewardCalibrationClosure, verifyRewardCalibrationClosure } from "../src/learning/reward-calibration-closure.js";

// A compiler upgrade must preserve immutable calibration evidence. Exercise the
// real deterministic grader and complete closure, including rejection of mixed
// snapshots; accepting only a changed path would miss this integrity failure.
test("retains exact checked calibrations across asset layouts", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  const fixtures = [true, false].map(passed => ({
    id: passed ? "matching" : "different", name: passed ? "Matching" : "Different",
    input: "{}", output: JSON.stringify({ text: passed ? "42" : "43" }), expectedOutput: JSON.stringify({ text: "42" }),
    evaluatorContext: "", artifactRefs: [], runtimeEventRefs: [], infrastructureError: "",
    expectedStatus: "scored" as const, minimumScore: passed ? "1" : "0", maximumScore: passed ? "1" : "0",
    expectedPassed: passed ? "true" as const : "false" as const,
  }));
  const draft = AuthoringDraftSchema.parse(sealLearningContent({
    schemaVersion: "openpond.authoringDraft.v1", id: "portable-reward-draft", targetId: "portable-reward",
    targetKind: "reward", editorVersion: "openpond.modelsEditor.v1", baseRelease: null, revision: 1,
    status: "draft", publishedRelease: null, createdAt: now, updatedAt: now,
    fields: { ...rewardAuthoringFields(null, null), name: "Exact answer", kind: "content", fixtures },
  }));
  if (draft.targetKind !== "reward") throw new Error("Reward draft required");
  const current = compileRewardCheck(draft, null);
  for (const layout of ["flat-v1", "content-addressed-v1"] as const) {
    const compiled = compileRewardCheck(draft, null, layout);
    const results = await Promise.all(compiled.fixtures.map(async fixture => matchRewardFixture(fixture,
      await executeRewardFixture({ reward: compiled.reward, fixture }))));
    expect(results.every(result => result.matchesExpectation)).toBe(true);
    const check = RewardCheckRunSchema.parse({
      schemaVersion: "openpond.rewardCheckRun.v1", id: `portable-check-${layout}`, revision: 1,
      draft: learningRef(draft), reward: learningRef(compiled.reward), snapshotHash: compiled.snapshotHash,
      fixtureRefs: compiled.fixtureRefs, results, status: "completed", matchesExpectations: true, failure: null,
      runtime: { id: "portable-deterministic-fixtures", packageVersion: "retained", engine: "JavaScript" },
      timeoutMs: 1000, maximumSpendUsd: 0, leaseOwner: null, leaseExpiresAt: null, attemptCount: 1,
      createdAt: now, updatedAt: now,
    });
    const reward = qualifyRewardCheck(draft, null, check).reward;
    const closure = createRewardCalibrationClosure({ schemaVersion: "openpond.rewardCalibrationClosure.v1",
      reward, draft, base: null, check, assets: compiled.assets });
    const original = JSON.stringify(closure);
    expect(JSON.stringify(verifyRewardCalibrationClosure(JSON.parse(original)))).toBe(original);
    expect(compileRewardCheck(draft, null)).toEqual(current);
    const mixed = structuredClone(closure);
    mixed.check.snapshotHash = contentHash("a different snapshot");
    const { contentHash: _hash, ...body } = mixed;
    mixed.contentHash = contentHash(body);
    expect(() => verifyRewardCalibrationClosure(mixed)).toThrow("snapshot_mismatch");
    const altered = structuredClone(closure);
    altered.assets[0]!.text += "changed";
    const { contentHash: _assetHash, ...alteredBody } = altered;
    altered.contentHash = contentHash(alteredBody);
    expect(() => verifyRewardCalibrationClosure(altered)).toThrow();
  }
});
