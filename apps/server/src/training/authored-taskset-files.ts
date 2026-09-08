import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TasksetSchema, type GeneratedTaskFile, type Taskset } from "@openpond/contracts";
import { contentHash, ImmutableAssetRefSchema, sha256, type ImmutableAssetRef } from "@openpond/harness";
import { computeTasksetHash, projectPortableTaskRecord } from "@openpond/taskset-sdk";
import { MAX_TASKSET_PACKAGE_BYTES } from "openpond-sdk/taskset-packages";

export const AuthoredTasksetFileInventorySchema = z.array(z.object({
  asset: ImmutableAssetRefSchema, sourcePath: z.string().min(1),
}).strict()).max(10_000);

// buildTaskset rewrites these protocol artifacts from the sealed manifest.
// Including taskset.json in its own inventory would create a hash cycle.
const GENERATED_MANIFESTS = new Set(["taskset.json", "capabilities.json", "data/tasks.jsonl", "graders/graders.json", "fixtures/grader-fixtures.json", "environment/taskset.ts"]);

/** Pin executable source and every additional private file before publishing
 * an ordinary authored revision. References never stand in for source bytes. */
export async function prepareAuthoredTasksetFiles(taskset: Taskset, directory: string) {
  if (taskset.metadata.taskDefinition !== undefined || taskset.metadata.rewardBinding !== undefined) return { taskset, generatedFiles: [] as GeneratedTaskFile[] };
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Taskset source must be a regular directory.");
  const bytes = new Map<string, Buffer>();
  let total = 0;
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Taskset files cannot contain symbolic links.");
      if (entry.name.startsWith(".env")) throw new Error("Environment files cannot be included in a Taskset package.");
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) throw new Error("Taskset packages require regular files.");
      if (GENERATED_MANIFESTS.has(name)) continue;
      if (bytes.size >= 10_000) throw new Error("Taskset source exceeds the file inventory limit.");
      const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const status = await handle.stat();
        total += status.size;
        if (!status.isFile() || total > MAX_TASKSET_PACKAGE_BYTES * 3 / 4) throw new Error("Taskset source exceeds the package byte limit.");
        const buffer = Buffer.alloc(status.size);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) throw new Error("Taskset source changed during capture.");
          offset += read.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error("Taskset source changed during capture.");
        bytes.set(name, buffer);
      } finally { await handle.close(); }
    }
  }
  await visit();
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
      const content = Buffer.from(grader.rubric, "utf8");
      const sourcePath = `graders/rubric-${sha256(content)}.md`;
      bytes.set(sourcePath, content);
      const asset = ref(`rubric-${grader.id}`, sourcePath, "text/markdown", "verifier");
      add(asset);
      generatedFiles.push({ path: sourcePath, role: "verifier", content: grader.rubric });
      return { ...grader, metadata: { ...grader.metadata, portableRubricRef: asset } };
    }
    return grader;
  });
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
  const prepared = TasksetSchema.parse({ ...taskset, graders,
    environment: { ...taskset.environment, metadata: environmentMetadata },
    metadata: { ...metadata, ...(importedPackageHash === undefined ? {} : { sourceImportedPackageHash: importedPackageHash }), portableFileInventory: AuthoredTasksetFileInventorySchema.parse([...inventory.values()].sort((left, right) => left.asset.id.localeCompare(right.asset.id))) } });
  return { taskset: TasksetSchema.parse({ ...prepared, contentHash: computeTasksetHash(prepared) }), generatedFiles };
}
