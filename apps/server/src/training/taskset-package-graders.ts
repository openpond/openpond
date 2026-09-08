import { GraderSpecSchema } from "@openpond/contracts";
import { decodeTasksetPackageFile, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { learningVerifierModule } from "@openpond/taskset-sdk";

/** Project an ordinary portable package without inventing a Reward binding. */
export function importedPackageGraders(value: TasksetPackage) {
  return value.taskset.graders.map(grader => {
    const base = { ...grader, label: grader.id, metadata: { portableGrader: grader } };
    if (grader.kind === "custom_verifier") return GraderSpecSchema.parse({ ...base,
      module: learningVerifierModule(grader.verifierRef.contentHash), exportName: grader.exportName ?? "verify",
      metadata: { ...base.metadata, portableVerifierRef: grader.verifierRef } });
    if (grader.kind === "human" || grader.kind === "model_judge") {
      const file = value.files.find(file => file.asset.id === grader.rubricRef.id);
      if (!file) throw new Error(`Imported rubric is missing: ${grader.id}.`);
      const rubric = new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file));
      if (grader.kind === "human") return GraderSpecSchema.parse({ ...base, rubric });
      if (!grader.model) throw new Error(`Imported judge ${grader.id} requires its declared model before local preparation.`);
      return GraderSpecSchema.parse({ ...base, rubric, judge: grader.model, temperature: grader.temperature ?? 0,
        calibrationStatus: "pending", calibrationFixtureRefs: value.verifierSet.calibrationReceiptRefs.map(ref => ref.id) });
    }
    return GraderSpecSchema.parse({ ...base, kind: grader.kind === "artifact" ? "file" : grader.kind });
  });
}
