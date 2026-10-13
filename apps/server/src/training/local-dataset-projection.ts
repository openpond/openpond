import { createTasksetDraftWorkspace, type TasksetDraftWorkspace } from "openpond-sdk/taskset-drafts";

/** A large local corpus stays whole; each run seals its selected tasks and
 * calibration dependencies, rather than copying unrelated policy PDFs. */
export function projectLocalDatasetWorkspace(workspace: TasksetDraftWorkspace, taskIds: string[]) {
  const {tasks,paths,policyPaths}=localDatasetProjectionPaths(workspace.draft,taskIds);
  const inventory = workspace.draft.metadata.portableFileInventory;
  const files = workspace.files.filter(file => !policyPaths.has(file.path) || paths.has(file.path));
  const retained = new Set(files.map(file => file.path));
  return createTasksetDraftWorkspace({schemaVersion:workspace.schemaVersion, files,
    draft:{...workspace.draft,tasks,metadata:{...workspace.draft.metadata,
      ...(Array.isArray(inventory) ? {portableFileInventory:inventory.filter(entry => retained.has(entry.sourcePath))} : {}),
      localDatasetTaskIds:taskIds,
    }},
  }, Number.POSITIVE_INFINITY);
}

export function localDatasetProjectionPaths(draft:TasksetDraftWorkspace["draft"],taskIds:string[]) {
  const selected = new Set(taskIds);
  if (!selected.size || selected.size !== taskIds.length || taskIds.some(id => !draft.tasks.some(task => task.id === id))) {
    throw new Error("Select distinct existing local Dataset tasks.");
  }
  for (const fixture of draft.graderFixtures) selected.add(fixture.taskId);
  const tasks = draft.tasks.filter(task => selected.has(task.id));
  const paths = new Set(tasks.flatMap(task => (task.assets ?? []).map(asset => asset.artifactRef)));
  const inventory = draft.metadata.portableFileInventory;
  const policyPaths = new Set<string>();
  if (Array.isArray(inventory)) for (const entry of inventory) {
    if (entry.asset?.visibility === "policy") policyPaths.add(entry.sourcePath);
  }
  return {tasks,paths,policyPaths};
}
