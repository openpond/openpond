import { expect, test } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { createTasksetDraft, materializePortableTasksetRelease, publishTasksetDraft } from "@openpond/taskset-sdk";
import { createTasksetPackage, prepareImportedTasksetPackage } from "openpond-sdk/taskset-packages";
import { retainModelTasksetInputReview } from "./model-taskset-review-projection.js";

// A Model must not silently approve substituted public files or private files
// when shared workflow resources become mounted inputs after package import.
test("retains exact owner-local workflow files with separate review provenance", () => {
  const bytes = Buffer.from("%PDF supplied input");
  const helper = Buffer.from("print('shared workflow')");
  const pdf = { id: "pdf", path: "inputs/source.pdf", contentHash: sha256(bytes), sizeBytes: bytes.length, mediaType: "application/pdf", visibility: "policy" as const };
  const workflow = { id: "workflow", path: "skills/helper.py", contentHash: sha256(helper), sizeBytes: helper.length, mediaType: "text/x-python", visibility: "policy" as const };
  const draft = createTasksetDraft({ id: "owner-dataset", profileId: "owner", name: "Owner Dataset" });
  const reviewed = publishTasksetDraft({ draft: { ...draft, objective: "Read source and use the workflow.",
    sourceRefs: [{ schemaVersion: "openpond.uploadedFileDatasetSource.v1", kind: "uploaded_file", id: "source", profileId: "owner", title: "Supplied PDF", sourceHash: sha256(bytes), occurredAt: draft.createdAt,
      licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", originalFileNames: ["source.pdf"], mediaTypes: [pdf.mediaType], sourceFileHashes: [pdf.contentHash], totalBytes: bytes.length, parserVersion: "fixture", metadata: {} },
      { schemaVersion: "openpond.uploadedFileDatasetSource.v1", kind: "uploaded_file", id: "workflow-source", profileId: "owner", title: "Reviewed workflow", sourceHash: workflow.contentHash, occurredAt: draft.createdAt,
        licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed", originalFileNames: ["helper.py"], mediaTypes: [workflow.mediaType], sourceFileHashes: [workflow.contentHash], totalBytes: helper.length, parserVersion: "fixture", metadata: {} }],
    environment: { ...draft.environment, kind: "work", entrypoint: "openpond-work-v1", toolNames: ["work_save_output"], resources: [{ id: "workflow-resource", kind: "file", path: workflow.path, mediaType: workflow.mediaType, visibility: "policy_visible", required: true, metadata: {} }] },
    tasks: [{ schemaVersion: "openpond.taskData.v1", id: "task", clusterKey: "family", split: "train", input: { prompt: "Read source" }, expectedOutput: { text: "done" }, policyVisibleContext: {}, privilegedContextRef: null, sourceRefs: ["source"], tags: [],
      assets: [{ id: pdf.id, sourceRefId: "source", artifactRef: pdf.path, fileName: "source.pdf", mediaType: pdf.mediaType, sha256: pdf.contentHash, sizeBytes: pdf.sizeBytes, split: "train", metadata: { portableAsset: pdf } }], requiredOutputs: [{ path: "result.txt", mediaType: "text/plain", schemaRef: null, maxBytes: 1024, metadata: {} }], metadata: { portableTaskRecord: { id: "task", clusterKey: "family", split: "train", input: { prompt: "Read source" }, expectedOutput: { text: "done" }, policyVisibleContext: {}, privilegedContextRef: null, artifactRefs: [pdf], requiredOutputs: [], tags: [] } } }],
    graders: [{ id: "answer", version: "1", label: "Answer", kind: "content", weight: 1, hardGate: false, rewardEligible: true, privileged: true, config: { operator: "final_answer_equals_expected" }, metadata: {} }],
  } });
  const releases = materializePortableTasksetRelease({ taskset: reviewed, adapterId: "fixture" });
  const pkg = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease, environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease,
    files: [{ asset: pdf, base64: bytes.toString("base64") }, { asset: workflow, base64: helper.toString("base64") }] });
  const imported = prepareImportedTasksetPackage({ package: pkg, profileId: reviewed.profileId, name: reviewed.name, createdAt: reviewed.createdAt }).taskset;
  expect(() => retainModelTasksetInputReview(imported, reviewed)).toThrow(/shared resource/);
  const missingReview = structuredClone(reviewed); missingReview.sourceRefs = missingReview.sourceRefs.filter(source => source.id !== "workflow-source");
  expect(() => retainModelTasksetInputReview(imported, missingReview, pkg)).toThrow(/exact bytes/);
  const retained = retainModelTasksetInputReview(imported, reviewed, pkg);
  expect(retained.sourceRefs[0]).toEqual(reviewed.sourceRefs[0]);
  const mounted = retained.tasks[0]!.assets!.find(asset => asset.id === workflow.id)!;
  const sharedSource = retained.sourceRefs.find(source => source.id === mounted.sourceRefId)!;
  expect(sharedSource.id).not.toBe("source");
  expect(sharedSource.sourceHash).toBe(workflow.contentHash);
  expect("sourceFileHashes" in sharedSource && sharedSource.sourceFileHashes).toEqual([workflow.contentHash]);
  expect(sharedSource.secretScanStatus).toBe("passed");
  expect(retained.tasks[0]!.assets!.find(asset => asset.id === pdf.id)?.sourceRefId).toBe("source");
  expect(contentHash(retained.tasks[0]!.metadata.portableTaskRecord)).toBe(contentHash(imported.tasks[0]!.metadata.portableTaskRecord));
  expect(imported.sourceRefs.every(source => source.licensingStatus === "pending")).toBe(true);
  const blocked = structuredClone(reviewed); for (const source of blocked.sourceRefs) source.secretScanStatus = "blocked";
  expect(retainModelTasksetInputReview(imported, blocked, pkg).sourceRefs.every(source => source.secretScanStatus === "blocked")).toBe(true);
  const substituted = structuredClone(imported); substituted.tasks[0]!.assets!.find(asset => asset.id === workflow.id)!.sha256 = "f".repeat(64);
  expect(() => retainModelTasksetInputReview(substituted, reviewed, pkg)).toThrow(/shared resource/);
  const privateAsset = structuredClone(imported); privateAsset.tasks[0]!.assets!.find(asset => asset.id === workflow.id)!.metadata.portableAsset = { ...workflow, visibility: "verifier" };
  expect(() => retainModelTasksetInputReview(privateAsset, reviewed, pkg)).toThrow(/shared resource/);
});
