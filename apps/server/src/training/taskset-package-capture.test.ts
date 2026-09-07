import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { bindTasksetExecutionReleases, createEnvironmentRelease, createVerifierSetRelease } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { decodeTasksetPackageFile } from "openpond-sdk/taskset-packages";
import { captureLocalTasksetPackage } from "./taskset-package-capture.js";

// Publication must carry actual private/binary bytes and must fail before a
// request if local content is corrupt, incomplete, or points outside its package.
it("captures portable files from their local paths and rejects unsafe or changed dependencies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskset-capture-"));
  const root = path.join(directory, "package");
  await mkdir(path.join(root, "assets"), { recursive: true });
  try {
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const asset = { id: "input", path: "tasks/task/input.bin", mediaType: "application/octet-stream", sizeBytes: bytes.length, contentHash: sha256(bytes), visibility: "policy" as const };
    const privateBytes = Buffer.from("private state");
    const privateAsset = { ...asset, id: "private", path: "private/state", sizeBytes: privateBytes.length, contentHash: sha256(privateBytes), visibility: "host_private" as const };
    const environment = createEnvironmentRelease({
      schemaVersion: "openpond.environmentRelease.v1", id: "environment", revision: 1,
      contract: { protocolVersion: "openpond.environment.v1", kind: "work", entrypoint: "work", stateful: true, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 1000 },
      actionSchemaRef: null, observationSchemaRef: null, stateSchemaRef: null,
      artifactCollection: { maxArtifacts: 10, maxTotalBytes: 1000 }, adapterConformanceHashes: {}, metadata: {},
    });
    const verifierSet = createVerifierSetRelease({ schemaVersion: "openpond.verifierSetRelease.v1", id: "verifiers", revision: 1, graders: [{ id: "verify", version: "1", kind: "custom_verifier", weight: 1, hardGate: true, rewardEligible: true, privileged: true, verifierRef: privateAsset, timeoutMs: 1000, networkPolicy: "none" }], isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1000 }, calibrationReceiptRefs: [], metadata: {} });
    const taskContent = {
      schemaVersion: "openpond.tasksetRelease.v2", id: "tasks", revision: 1,
      policy: { policyVisibleFields: ["input"], privilegedFields: [], hiddenGraderRefs: [], connectedAppScopes: [] }, environment: environment.contract, tools: [], capabilities: [], graders: verifierSet.graders,
      tasks: [{ id: "task", clusterKey: "task", split: "train", input: { prompt: "read" }, expectedOutput: null, policyVisibleContext: {}, privilegedContextRef: privateAsset.id, artifactRefs: [asset], tags: [] }], metadata: {},
    };
    const taskset = bindTasksetExecutionReleases({ taskset: TasksetReleaseSchema.parse({ ...taskContent, contentHash: contentHash(taskContent) }), environment, verifierSet });
    const content = { schemaVersion: "openpond.tasksetPackage.v1" as const, taskset, environment, verifierSet };
    await writeFile(path.join(root, "assets/input.bin"), bytes);
    await writeFile(path.join(root, "assets/private.bin"), privateBytes);
    const sources = [{ asset, sourcePath: "assets/input.bin" }, { asset: privateAsset, sourcePath: "assets/private.bin" }];
    const captured = await captureLocalTasksetPackage({ root, content, sources });
    expect(Buffer.from(decodeTasksetPackageFile(captured.files[0]!))).toEqual(bytes);
    expect(captured.files[0]!.asset.path).toBe("tasks/task/input.bin");
    expect(Buffer.from(decodeTasksetPackageFile(captured.files[1]!))).toEqual(privateBytes);
    await expect(captureLocalTasksetPackage({ root, content, sources: sources.slice(0, 1) })).rejects.toThrow("private context");
    await writeFile(path.join(root, "assets/input.bin"), Buffer.alloc(bytes.length));
    await expect(captureLocalTasksetPackage({ root, content, sources })).rejects.toThrow("immutable bytes");
    await writeFile(path.join(directory, "outside.bin"), bytes);
    await expect(captureLocalTasksetPackage({ root, content, sources: [{ asset, sourcePath: "../outside.bin" }] })).rejects.toThrow("escapes");
    await symlink(directory, path.join(root, "linked"));
    await expect(captureLocalTasksetPackage({ root, content, sources: [{ asset, sourcePath: "linked/outside.bin" }] })).rejects.toThrow("escapes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
