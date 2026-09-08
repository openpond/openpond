import { z } from "zod";
import { contentHash, ImmutableAssetRefSchema, sha256, type ImmutableAssetRef } from "@openpond/harness";
import { TasksetSchema, type GeneratedTaskFile, type Taskset } from "./taskset-authored-contracts.js";
import { computeTasksetHash } from "./taskset-authored-validation.js";
import { projectPortableTaskRecord } from "./taskset-authored-portable-release.js";
import { TasksetDraftFilePathSchema } from "./model-taskset-authoring-contracts.js";
import { MAX_TASKSET_PACKAGE_BYTES } from "./taskset-package-files.js";
import { prepareAuthoredToolEnvironment } from "./taskset-authored-tool-environment.js";

export const AuthoredTasksetFileInventorySchema = z.array(z.object({
  asset: ImmutableAssetRefSchema, sourcePath: z.string().min(1),
}).strict()).max(10_000);

const GENERATED_MANIFESTS = new Set(["taskset.json", "capabilities.json", "data/tasks.jsonl", "graders/graders.json", "fixtures/grader-fixtures.json", "environment/taskset.ts"]);
export function isGeneratedTasksetPublicationFilePath(path: string): boolean { return GENERATED_MANIFESTS.has(path); }

/** Seal one captured file population; hosts own filesystem or object-store capture. */
export function prepareAuthoredTasksetSource(tasksetInput: Taskset, sourceFiles: ReadonlyMap<string, Uint8Array>, adapterId: string) {
  const taskset = TasksetSchema.parse(tasksetInput);
  if (taskset.metadata.taskDefinition !== undefined || taskset.metadata.rewardBinding !== undefined) return { taskset, generatedFiles: [] as GeneratedTaskFile[] };
  const bytes = new Map<string, Uint8Array>();
  let total = 0;
  for (const [name, data] of sourceFiles) {
    TasksetDraftFilePathSchema.parse(name);
    total += data.byteLength;
    if (bytes.size >= 10_000 || total > MAX_TASKSET_PACKAGE_BYTES * 3 / 4) throw new Error("Taskset source exceeds the package byte limit.");
    bytes.set(name, data.slice());
  }
  const aggregator = taskset.metrics?.customAggregator;
  const aggregatorBytes = aggregator ? bytes.get(aggregator.module) : undefined;
  if (aggregator && !aggregatorBytes) throw new Error("Declared Taskset metric module is missing.");
  const metrics = aggregator && aggregatorBytes ? { ...taskset.metrics!, customAggregator: { ...aggregator, contentHash: sha256(aggregatorBytes) } } : taskset.metrics;
  const inventory = new Map<string, { asset: ImmutableAssetRef; sourcePath: string }>();
  const declaredPaths = new Set<string>();
  const generatedFiles: GeneratedTaskFile[] = [];
  const ref = (id: string, sourcePath: string, mediaType: string, visibility: ImmutableAssetRef["visibility"]): ImmutableAssetRef => {
    const source = bytes.get(sourcePath);
    if (!source) throw new Error(`Declared Taskset file is missing: ${sourcePath}.`);
    return { id, path: sourcePath, contentHash: sha256(source), sizeBytes: source.byteLength, mediaType, visibility };
  };
  const add = (asset: ImmutableAssetRef, sourcePath = asset.path) => {
    const previous = inventory.get(asset.id);
    if (previous && contentHash(previous) !== contentHash({ asset, sourcePath })) throw new Error(`Conflicting Taskset file identity: ${asset.id}.`);
    const source = bytes.get(sourcePath);
    if (!source || source.length !== asset.sizeBytes || sha256(source) !== asset.contentHash) throw new Error(`Taskset file differs from its declared bytes: ${asset.id}.`);
    inventory.set(asset.id, { asset, sourcePath });
    declaredPaths.add(sourcePath);
  };
  for (const task of taskset.tasks) {
    const portable = projectPortableTaskRecord(task);
    for (const asset of portable.artifactRefs) add(asset, task.assets?.find(candidate => candidate.id === asset.id)?.artifactRef ?? asset.path);
    for (const output of portable.requiredOutputs ?? []) if (output.schemaRef) add(output.schemaRef);
  }
  for (const resource of taskset.environment.resources ?? []) add(ref(resource.id, resource.path, resource.mediaType ?? "application/octet-stream", resource.visibility === "policy_visible" ? "policy" : "host_private"));
  const graders = taskset.graders.map(grader => {
    if (grader.kind === "custom_verifier") {
      let asset = ref(`verifier-${grader.id}`, grader.module, "application/javascript", "host_private");
      const previous = ImmutableAssetRefSchema.safeParse(grader.metadata.portableVerifierRef);
      if (previous.success && previous.data.contentHash === asset.contentHash && previous.data.sizeBytes === asset.sizeBytes) asset = previous.data;
      add(asset, grader.module);
      return { ...grader, metadata: { ...grader.metadata, portableVerifierRef: asset } };
    }
    if (grader.kind === "human" || grader.kind === "model_judge") {
      const content = new TextEncoder().encode(grader.rubric);
      const sourcePath = `graders/rubric-${sha256(content)}.md`;
      bytes.set(sourcePath, content);
      const asset = ref(`rubric-${grader.id}`, sourcePath, "text/markdown", "verifier");
      add(asset);
      generatedFiles.push({ path: sourcePath, role: "verifier", content: grader.rubric });
      return { ...grader, metadata: { ...grader.metadata, portableRubricRef: asset } };
    }
    return grader;
  });
  if (aggregator && ![...inventory.values()].some(file => file.asset.path === aggregator.module && file.sourcePath === aggregator.module && file.asset.visibility !== "policy")) {
    add(ref(`metric-${contentHash(aggregator.module)}`, aggregator.module, "application/javascript", "host_private"));
  }
  // Unreferenced source files are retained privately. Only explicit task or
  // environment declarations can make bytes visible to the policy.
  const previousInventory = AuthoredTasksetFileInventorySchema.parse(taskset.metadata.portableFileInventory ?? []);
  for (const name of [...bytes.keys()].sort()) if (!declaredPaths.has(name)) {
    const previous = previousInventory.find(file => file.sourcePath === name && !inventory.has(file.asset.id));
    add(previous
      ? { ...ref(previous.asset.id, name, previous.asset.mediaType, previous.asset.visibility), path: previous.asset.path }
      : ref(`taskset-file-${contentHash(name)}`, name, "application/octet-stream", "host_private"), name);
  }
  // Publication creates a new release; imported cache and execution identities
  // describe the source revision, not the newly edited graders.
  const { importedPackageHash, derivedPortableMetadata: _derived, ...metadata } = taskset.metadata;
  const environmentMetadata = { ...taskset.environment.metadata };
  if (environmentMetadata.portableExecutionResources !== undefined) {
    const resources = z.object({ environment: z.unknown(), verifierSet: z.unknown().optional() }).parse(environmentMetadata.portableExecutionResources);
    environmentMetadata.portableExecutionResources = { environment: resources.environment };
  }
  const prepared = TasksetSchema.parse({ ...taskset, graders, metrics,
    environment: { ...taskset.environment, metadata: environmentMetadata },
    metadata: { ...metadata, ...(importedPackageHash === undefined ? {} : { sourceImportedPackageHash: importedPackageHash }), portableFileInventory: AuthoredTasksetFileInventorySchema.parse([...inventory.values()].sort((left, right) => left.asset.id.localeCompare(right.asset.id))) } });
  const executable = prepareAuthoredToolEnvironment(prepared, bytes, [...inventory.values()], adapterId);
  return { taskset: TasksetSchema.parse({ ...executable.taskset, contentHash: computeTasksetHash(executable.taskset) }), generatedFiles: [...generatedFiles, ...executable.generatedFiles] };
}
