import { contentHash } from "@openpond/harness";
import { createTasksetDraftWorkspace, validateTasksetDraftWorkspace, type TasksetDraftWorkspace } from "./taskset-draft-workspace.js";

/** Composition preserves task inputs and isolates each checker population.
 * This is a new unqualified package: individual reports cannot certify it. */
export function assemblePreparedTaskWorkspaces(input: {
  base: TasksetDraftWorkspace; candidates: TasksetDraftWorkspace[];
  preparationId: string; revision: number; now: string;
}): TasksetDraftWorkspace {
  const base = validateTasksetDraftWorkspace(input.base);
  const candidates = input.candidates.map(workspace => validateTasksetDraftWorkspace(workspace));
  if (!candidates.length || base.draft.status !== "draft" || candidates.some(workspace => workspace.draft.profileId !== base.draft.profileId || workspace.draft.tasks.length !== 1))
    throw new Error("Prepared assembly requires owned individual task workspaces and an editable destination.");
  const environment = base.draft.tasks.length ? base.draft.environment : candidates[0]!.draft.environment;
  if (candidates.some(workspace => contentHash(workspace.draft.environment) !== contentHash(environment)))
    throw new Error("Prepared tasks require separate versions for incompatible execution environments.");
  const tasks = [...base.draft.tasks], files = [...base.files], graders = base.draft.graders.map(grader => ({ ...grader,
    ...(grader.taskIds ? {} : { taskIds: base.draft.tasks.map(task => task.id) }) }));
  if (!base.draft.tasks.length && graders.length) throw new Error("Destination graders require their original task population.");
  const sources = new Map(base.draft.sourceRefs.map(source => [source.id, source]));
  const fixtures = [...base.draft.graderFixtures];
  const inventory = [...(base.draft.metadata.portableFileInventory ?? []) as Array<{ asset: Record<string, unknown>; sourcePath: string }>];
  const candidateIds: string[] = [];
  for (const workspace of candidates) {
    const task = workspace.draft.tasks[0]!;
    if (tasks.some(existing => existing.id === task.id)) throw new Error("Prepared assembly repeats a task identity.");
    const provenance = task.metadata.preparedTask as { preparationId?: unknown } | undefined;
    if (provenance?.preparationId !== input.preparationId) throw new Error("Prepared task belongs to another run.");
    const sourceIds = new Map(workspace.draft.sourceRefs.map(source => [source.id, `prepared-source-${contentHash([task.id, source.id]).slice(0, 40)}`]));
    candidateIds.push(task.id); tasks.push({ ...task, sourceRefs: task.sourceRefs.map(id => sourceIds.get(id)!),
      ...(task.assets ? { assets: task.assets.map(asset => ({ ...asset, sourceRefId: sourceIds.get(asset.sourceRefId)! })) } : {}) });
    const namespace = `graders/${task.id}/`;
    for (const file of workspace.files) files.push({ ...file, path: file.path.startsWith("assets/") ? file.path : namespace + file.path });
    const graderIds = new Map(workspace.draft.graders.map(grader => [grader.id, `prepared-grader-${contentHash([task.id, grader.id]).slice(0, 40)}`]));
    for (const grader of workspace.draft.graders) {
      const id = graderIds.get(grader.id)!;
      // Executable relative imports stay together. Their new paths and IDs are
      // independently checked again against the final compiled package.
      graders.push({ ...grader, id, taskIds: [task.id],
        ...(grader.kind === "custom_verifier" ? { module: namespace + grader.module } : {}),
        metadata: { ...grader.metadata, preparedTask: task.id, composedFrom: { id: grader.id, contentHash: contentHash(grader) } } });
    }
    for (const fixture of workspace.draft.graderFixtures) {
      const projection = fixture.metadata.rewardCalibration as { graderId?: string; sourceReward?: { id: string } } | undefined;
      if (projection) fixtures.push({ ...fixture, metadata: { ...fixture.metadata, rewardCalibration: { ...projection,
        graderId: graderIds.get(projection.graderId ?? projection.sourceReward!.id)! } } });
      else fixtures.push({ ...fixture, id: `prepared-fixture-${contentHash([task.id, fixture.id]).slice(0, 40)}` });
    }
    for (const entry of (workspace.draft.metadata.portableFileInventory ?? []) as typeof inventory) inventory.push({ ...entry,
      sourcePath: entry.sourcePath.startsWith("assets/") ? entry.sourcePath : namespace + entry.sourcePath });
    for (const source of workspace.draft.sourceRefs) sources.set(sourceIds.get(source.id)!, { ...source,
      id: sourceIds.get(source.id)!, metadata: { ...source.metadata, assemblyOriginalSourceId: source.id } });
  }
  const policyVisibleFields = [...new Set(candidates.flatMap(workspace => workspace.draft.policy.policyVisibleFields).concat(base.draft.tasks.length ? base.draft.policy.policyVisibleFields : []))];
  return createTasksetDraftWorkspace({ schemaVersion: base.schemaVersion, files,
    draft: { ...base.draft, name: base.draft.name.trim() || `Prepared ${candidates.length} tasks`,
      objective: base.draft.objective.trim() || candidates.map(workspace => workspace.draft.objective).join("\n").slice(0, 50_000), revision: input.revision, updatedAt: input.now, environment, tasks, graders, graderFixtures: fixtures,
      sourceRefs: [...sources.values()], policy: { ...base.draft.policy, policyVisibleFields,
        privilegedFields: [...new Set(["expectedOutput", ...base.draft.policy.privilegedFields])], hiddenGraderRefs: graders.map(grader => grader.id) },
      metadata: { ...base.draft.metadata, portableFileInventory: inventory, datasetPreparation: { schemaVersion: "openpond.datasetPreparationAssembly.v1", preparationId: input.preparationId,
        candidateIds, baseWorkspaceHash: base.contentHash, authoredWorkspaceHashes: candidates.map(workspace => workspace.contentHash), qualification: "pending" } } } });
}
