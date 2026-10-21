import { expect, test } from "vitest";
import { sha256 } from "@openpond/harness";
import { computeTasksetHash, createTasksetDraft, materializePortableTasksetRelease, publishTasksetDraft } from "@openpond/taskset-sdk";
import { createTasksetPackage, prepareImportedTasksetPackage } from "openpond-sdk/taskset-packages";
import { retainModelTasksetInputReview } from "./model-taskset-review-projection.js";
import { prepareModelProjectPullSnapshot } from "./model-project-pull-snapshot.js";

// A signed-in Model's exact reviewed source must be recoverable, while a caller
// cannot use that recovery to substitute input bytes, targets or a forged hash.
test("recovers authenticated reviewed source and fences snapshot substitution", () => {
  const bytes = Buffer.from("supplied source");
  const asset = { id: "input", path: "inputs/source.txt", contentHash: sha256(bytes), sizeBytes: bytes.length, mediaType: "text/plain", visibility: "policy" as const };
  const draft = createTasksetDraft({ id: "reviewed-source", profileId: "owner", name: "Reviewed source" });
  const reviewed = publishTasksetDraft({ draft: { ...draft, objective: "Extract the supplied fact.",
    sourceRefs: [{ schemaVersion: "openpond.uploadedFileDatasetSource.v1", kind: "uploaded_file", id: "source", profileId: "owner", title: "Supplied input", sourceHash: asset.contentHash, occurredAt: draft.createdAt,
      licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", originalFileNames: ["source.txt"], mediaTypes: [asset.mediaType], sourceFileHashes: [asset.contentHash], totalBytes: bytes.length, parserVersion: "fixture", metadata: {} }],
    environment: { ...draft.environment, kind: "work", entrypoint: "openpond-work-v1", toolNames: ["work_save_output"] },
    tasks: [{ schemaVersion: "openpond.taskData.v1", id: "task", clusterKey: "family", split: "train", input: { prompt: "Read source" }, expectedOutput: { text: "fact" }, policyVisibleContext: {}, privilegedContextRef: null, sourceRefs: ["source"], tags: [],
      assets: [{ id: asset.id, sourceRefId: "source", artifactRef: asset.path, fileName: "source.txt", mediaType: asset.mediaType, sha256: asset.contentHash, sizeBytes: asset.sizeBytes, split: "train", metadata: { portableAsset: asset } }], requiredOutputs: [{ path: "result.txt", mediaType: "text/plain", schemaRef: null, maxBytes: 1024, metadata: {} }], metadata: { portableTaskRecord: { id: "task", clusterKey: "family", split: "train", input: { prompt: "Read source" }, expectedOutput: { text: "fact" }, policyVisibleContext: {}, privilegedContextRef: null, artifactRefs: [asset], requiredOutputs: [], tags: [] } } }],
    graders: [{ id: "answer", version: "1", label: "Answer", kind: "content", weight: 1, hardGate: false, rewardEligible: true, privileged: true, config: { operator: "final_answer_equals_expected" }, metadata: {} }],
  } });
  const releases = materializePortableTasksetRelease({ taskset: reviewed, adapterId: "fixture" });
  const pkg = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease,
    files: [{ asset, base64: bytes.toString("base64") }] });
  const generic = prepareImportedTasksetPackage({ package: pkg, profileId: reviewed.profileId, name: reviewed.name, createdAt: reviewed.createdAt });
  const saved = retainModelTasksetInputReview(generic.taskset, reviewed, pkg);
  const ref = { id: saved.id, revision: saved.revision, contentHash: saved.contentHash };
  const snapshot = { schemaVersion: "openpond.modelProjectPullSnapshot.v1" as const, package: pkg, taskset: saved };
  expect(prepareModelProjectPullSnapshot(snapshot, ref, "owner").taskset).toEqual(saved);
  expect(generic.taskset.sourceRefs[0]!.secretScanStatus).toBe("pending");
  const forged = structuredClone(snapshot); forged.taskset.tasks[0]!.expectedOutput = { text: "substitute" };
  expect(() => prepareModelProjectPullSnapshot(forged, ref, "owner")).toThrow(/content hash/);
  forged.taskset.contentHash = computeTasksetHash(forged.taskset);
  expect(() => prepareModelProjectPullSnapshot(forged, { ...ref, contentHash: forged.taskset.contentHash }, "owner")).toThrow(/compiled task content/);
  const substituted = structuredClone(snapshot); substituted.taskset.tasks[0]!.assets![0]!.sha256 = "f".repeat(64);
  substituted.taskset.contentHash = computeTasksetHash(substituted.taskset);
  expect(() => prepareModelProjectPullSnapshot(substituted, { ...ref, contentHash: substituted.taskset.contentHash }, "owner")).toThrow(/compiled input asset/);
  expect(() => prepareModelProjectPullSnapshot(snapshot, ref, "another-owner")).toThrow(/exact Profile/);
});
