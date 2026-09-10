import { compileBoundGraders, resolveBoundRewards, type RewardBinding, type RewardRelease } from "@openpond/evals/rewards";
import { learningRef, verifyLearningTextAsset, RewardFixtureAuthoringFieldsSchema, type LearningTextAsset } from "@openpond/evals/learning";
import type { GraderSpec } from "./taskset-draft-core.js";
import { GraderSpecSchema } from "./taskset-draft-core.js";
import { decodeTasksetPackageFile, type TasksetPackage } from "./taskset-package-contracts.js";
import { z } from "zod";

/** Project an ordinary portable package without inventing a Reward binding. */
export function importedPackageGraders(value: TasksetPackage) {
  const authoring = value.taskset.metadata.ordinaryAuthoring as { judgeCalibrationFixtures?: unknown } | undefined;
  const calibrationFixtures = z.record(z.string(), z.array(z.string().min(1)).max(100_000)).parse(authoring?.judgeCalibrationFixtures ?? {});
  return value.taskset.graders.map(grader => {
    const base = { ...grader, label: grader.id, metadata: { portableGrader: grader } };
    if (grader.kind === "custom_verifier") return GraderSpecSchema.parse({ ...base,
      module: learningVerifierModule(grader.verifierRef.contentHash), exportName: grader.exportName ?? "verify",
      metadata: { ...base.metadata, portableVerifierRef: grader.verifierRef } });
    if (grader.kind === "human" || grader.kind === "model_judge") {
      const file = value.files.find(file => file.asset.id === grader.rubricRef.id);
      if (!file) throw new Error(`Imported rubric is missing: ${grader.id}.`);
      const rubric = new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file));
      const metadata = { ...base.metadata, portableRubricRef: grader.rubricRef };
      if (grader.kind === "human") return GraderSpecSchema.parse({ ...base, rubric, metadata });
      if (!grader.model) throw new Error(`Imported judge ${grader.id} requires its declared model before local preparation.`);
      return GraderSpecSchema.parse({ ...base, rubric, metadata, judge: grader.model, temperature: grader.temperature ?? 0,
        calibrationStatus: "pending", calibrationFixtureRefs: calibrationFixtures[grader.id] ?? [] });
    }
    return GraderSpecSchema.parse({ ...base, kind: grader.kind === "artifact" ? "file" : grader.kind,
      config: grader.kind === "artifact" ? { ...grader.config, ...(grader.config.refIncludes === undefined ? {} : { pathIncludes: grader.config.refIncludes }) } : grader.config });
  });
}

export function projectLearningBatchGraders(binding: RewardBinding, rewards: RewardRelease[], assets: LearningTextAsset[] = []): GraderSpec[] {
  const resolved = resolveBoundRewards(binding, rewards);
  return compileBoundGraders(binding, rewards).map((grader) => {
    const reward = resolved.find(({ source }) => source.graderId === grader.id)!.reward;
    const base = { ...grader, label: reward.name, metadata: { rewardBinding: learningRef(binding) } };
    if (grader.kind === "model_judge") {
      if (!grader.model || grader.calibrationStatus !== "passed" || !reward.calibrationCheckRef || !reward.fixtureSetRef) throw new Error(`Reward ${grader.id} needs a retained passing calibration check before preparation.`);
      const rubric = assets.find(asset => asset.id === grader.rubricRef.id);
      const fixtures = assets.find(asset => asset.id === reward.fixtureSetRef!.id);
      if (!rubric || !fixtures) throw new Error(`Reward ${grader.id} is missing its immutable rubric or calibration fixtures.`);
      const fields = RewardFixtureAuthoringFieldsSchema.array().min(1).max(50).parse(JSON.parse(verifyLearningTextAsset(fixtures, reward.fixtureSetRef)));
      return GraderSpecSchema.parse({ ...base, rubric: verifyLearningTextAsset(rubric, grader.rubricRef), judge: grader.model,
        temperature: grader.temperature ?? 0, calibrationFixtureRefs: fields.map(fixture => fixture.id),
        metadata: { ...base.metadata, portableRubricRef: grader.rubricRef,
          calibrationEvidenceHash: reward.calibrationCheckRef.contentHash, calibrationCheckRef: reward.calibrationCheckRef },
      });
    }
    if (grader.kind === "custom_verifier") return GraderSpecSchema.parse({ ...base,
      module: learningVerifierModule(grader.verifierRef.contentHash), exportName: grader.exportName ?? "verify",
      metadata: { ...base.metadata, portableVerifierRef: grader.verifierRef },
    });
    if (grader.kind === "human") {
      const asset = assets.find((asset) => asset.id === grader.rubricRef.id);
      if (!asset) throw new Error(`Reward ${grader.id} is missing its immutable rubric.`);
      return GraderSpecSchema.parse({ ...base, rubric: verifyLearningTextAsset(asset, grader.rubricRef) });
    }
    return GraderSpecSchema.parse({ ...base, kind: grader.kind === "artifact" ? "file" : grader.kind });
  });
}

export function learningVerifierModule(hash: string) { return `graders/reward-${hash}.js`; }
