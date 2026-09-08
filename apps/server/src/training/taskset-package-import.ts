import path from "node:path";
import { GraderFixtureSchema, TasksetEnvironmentResourceSchema, TasksetSchema, TasksetSourceRefSchema, type GeneratedTaskFile } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { learningRef, taskBatchPackageMetadata, verifyLearningTextAsset } from "@openpond/evals/learning";
import { computeTasksetHash, createTasksetDraft, learningVerifierModule, projectLearningBatchGraders } from "@openpond/taskset-sdk";
import { decodeTasksetPackageFile, resolveTasksetPackageInstructions, validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { importedTasksetPackageDirectory } from "./taskset-package-files.js";
import { importedPackageGraders } from "./taskset-package-graders.js";

/** Local identity includes Profile and provenance; portable identity stays in
 * the receipt. Downloading does not approve targets, privacy or licensing. */
export function prepareImportedTasksetPackage(input: {
  package: TasksetPackage; profileId: string; name: string; createdAt: string;
}) {
  const value = validateTasksetPackage(input.package);
  const release = value.taskset;
  const resources = value.modelResources;
  const learning = value.learningResources ? taskBatchPackageMetadata(release) : undefined;
  const source = TasksetSourceRefSchema.parse({
    schemaVersion: "openpond.uploadedFileDatasetSource.v1", kind: "uploaded_file",
    id: `package-source-${contentHash({ profileId: input.profileId, packageHash: value.contentHash })}`,
    profileId: input.profileId, title: input.name, sourceHash: value.contentHash, occurredAt: input.createdAt,
    licensingStatus: "pending", secretScanStatus: "pending", piiScanStatus: "pending",
    originalFileNames: ["taskset-package.json"], mediaTypes: ["application/json"], sourceFileHashes: [value.contentHash],
    totalBytes: Buffer.byteLength(JSON.stringify(value)), parserVersion: "openpond.tasksetPackage.v1", metadata: {},
  });
  const draft = createTasksetDraft({ profileId: input.profileId, id: `${release.id}-import`, name: input.name, now: input.createdAt });
  const files: GeneratedTaskFile[] = [];
  for (const grader of release.graders) if (grader.kind === "custom_verifier") {
    const asset = resources?.assets.find(asset => asset.id === grader.verifierRef.id);
    const file = value.files.find(file => file.asset.id === grader.verifierRef.id);
    if (!file) throw new Error(`Imported verifier source is missing: ${grader.id}.`);
    const name = learningVerifierModule(grader.verifierRef.contentHash);
    if (!files.some(file => file.path === name)) files.push({ path: name, role: "verifier", content: asset ? verifyLearningTextAsset(asset, grader.verifierRef) : new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file)) });
  }
  const authoring = (release.metadata.ordinaryAuthoring ?? release.metadata.starterAuthoring) as { graderFixtures?: unknown } | undefined;
  const fixtures = GraderFixtureSchema.array().max(100_000).parse(authoring?.graderFixtures ?? []);
  const kind = release.environment.kind === "text" ? "chat" : release.environment.kind === "custom_program" ? "program" : release.environment.kind;
  const projected = TasksetSchema.parse({
    schemaVersion: "openpond.taskset.v1", id: release.id, revision: release.revision,
    profileId: input.profileId, profileRelease: null, createImproveRunId: null,
    name: input.name, objective: resolveTasksetPackageInstructions(value), status: "needs_review",
    sourceRefs: [source], datasetArtifact: null, policy: release.policy,
    environment: { ...draft.environment, kind, entrypoint: release.environment.entrypoint,
      resources: TasksetEnvironmentResourceSchema.array().max(10_000).parse(release.metadata.environmentResources ?? []),
      stateful: release.environment.stateful, deterministicSeeds: release.environment.deterministicSeeds,
      toolNames: release.tools.map(tool => tool.name), defaultTimeoutMs: release.environment.defaultTimeoutMs,
      networkPolicy: release.environment.networkPolicy, metadata: {
        runtimeSourceTasksetId: importedTasksetPackageDirectory(input.profileId, value.contentHash),
        portableEnvironment: release.environment, portableTools: release.tools,
        portableExecutionResources: { environment: value.environment, verifierSet: value.verifierSet },
      } },
    capabilities: { ...draft.capabilities, taskKind: kind === "chat" ? "chat" : kind === "program" ? "custom_program" : "single_agent",
      compatibleMethods: ["none"], requiresTools: release.tools.length > 0, requiresState: release.environment.stateful,
      rewardKinds: [...new Set(release.graders.map(grader => grader.kind === "human" ? "human" : grader.kind === "model_judge" ? "model_judge" : "deterministic"))],
    },
    tasks: release.tasks.map(task => ({ ...task, schemaVersion: "openpond.taskData.v1", sourceRefs: [source.id],
      assets: task.artifactRefs.map(asset => ({ id: asset.id, sourceRefId: source.id, artifactRef: asset.path,
        fileName: path.posix.basename(asset.path), mediaType: asset.mediaType, sha256: asset.contentHash,
        sizeBytes: asset.sizeBytes, split: task.split, metadata: { portableAsset: asset } })),
      ...(task.requiredOutputs ? { requiredOutputs: task.requiredOutputs.map(output => ({ ...output,
        schemaRef: output.schemaRef?.id ?? null, maxBytes: output.maxBytes ?? undefined })) } : {}),
      metadata: { portableTaskRecord: task, exampleOrigin: "imported" },
    })),
    graders: resources ? projectLearningBatchGraders(resources.rewardBinding, resources.rewards, resources.assets)
      : learning ? projectLearningBatchGraders(learning.binding, learning.rewards, value.learningResources!.assets) : importedPackageGraders(value),
    graderFixtures: fixtures, learningSignals: draft.learningSignals,
    ...(release.metrics ? { metrics: release.metrics } : {}),
    authoringProvenance: { schemaVersion: "openpond.taskAuthoringProvenance.v1", model: null, modelConfig: {},
      skillHash: contentHash("openpond-package-import-v1"), promptTemplateVersion: "package-import-v1", buildIntent: "discovery",
      buildSpecification: null, evidenceHashes: [value.contentHash], tasksetSdkVersion: "package-import-v1",
      sourceCommit: null, repairHistory: [], createdAt: input.createdAt },
    readiness: null, contentHash: "00000000", createdAt: input.createdAt, updatedAt: input.createdAt,
    metadata: { importedPackageHash: value.contentHash,
      ...(learning ? { learning } : {}),
      portableFileInventory: value.files.map(file => ({ asset: file.asset, sourcePath: file.asset.path })),
      ...(resources ? { taskDefinition: learningRef(resources.taskDefinition),
      rewardBinding: learningRef(resources.rewardBinding), rewardExecution: { binding: resources.rewardBinding, rewards: resources.rewards } } : {}),
      portableCapabilities: release.capabilities, derivedPortableMetadata: release.metadata,
      ...(release.metadata.modelTasksetDerivation ? { modelTasksetDerivation: release.metadata.modelTasksetDerivation } : {}),
    },
  });
  return { package: value, taskset: TasksetSchema.parse({ ...projected, contentHash: computeTasksetHash(projected) }), generatedFiles: files };
}

export type PreparedImportedTasksetPackage = ReturnType<typeof prepareImportedTasksetPackage> & { reuseExisting?: boolean };
