import type { ModelProject, Taskset } from "@openpond/contracts";
import { SqliteTasksetDraftStore } from "./store-taskset-drafts.js";
import type { ModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { commitModelProjectSave, findModelProjectSave } from "./store-model-project-authoring.js";
import { commitModelStarterCreation, findModelStarterCreation, type ModelStarterCommitInput } from "./store-model-starters.js";
import { commitModelProjectHosting } from "./store-model-project-hosting.js";
import { prepareModelTasksetSave } from "./store-model-taskset-derivation.js";
import { materializeImmutableTasksetPackage } from "../training/model-starter-package-files.js";
import { prepareModelStarterTaskset } from "../training/model-starter-taskset.js";
import { resolveModelStarterSelection } from "./store-model-starter-selection.js";

/** Model configuration, starter publication and hosting share the store write queue. */
export class SqliteModelConfigurationStore extends SqliteTasksetDraftStore {
  async findModelProjectConfigurationSave(request: ModelProjectSaveRequest): Promise<ModelProject | null> {
    await this.ready;
    await this.writeQueue;
    if (!this.db) throw new Error("Model check failed because the local store is closed.");
    return findModelProjectSave(this.db, request);
  }

  async saveModelProjectConfiguration(request: ModelProjectSaveRequest): Promise<ModelProject> {
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      if (!this.db) throw new Error("Model save failed because the local store is closed.");
      const previous = findModelProjectSave(this.db, request);
      if (previous) return previous;
      const prepared = prepareModelTasksetSave(this.db, request);
      if (prepared) {
        await materializeImmutableTasksetPackage(this.home, prepared, prepared.directoryId);
        this.db.run("UPDATE model_project_taskset_preparations SET state = 'materialized' WHERE profile_id = ? AND operation_id = ?", [request.project.profileId, request.operationId]);
      }
      return commitModelProjectSave(this.db, request, prepared);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async previewModelProjectTasksetSave(request: ModelProjectSaveRequest): Promise<Taskset | null> {
    await this.ready;
    await this.writeQueue;
    if (!this.db) throw new Error("Model check failed because the local store is closed.");
    return prepareModelTasksetSave(this.db, request, false)?.taskset ?? null;
  }

  async findModelStarterCreation(request: ModelStarterCommitInput["request"]): Promise<ModelProject | null> {
    await this.ready;
    await this.writeQueue;
    if (!this.db) throw new Error("Starter lookup failed because the local store is closed.");
    return findModelStarterCreation(this.db, request);
  }

  async saveModelStarterCreation(input: ModelStarterCommitInput): Promise<ModelProject> {
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      if (!this.db) throw new Error("Starter creation failed because the local store is closed.");
      const previous = findModelStarterCreation(this.db, input.request);
      if (previous) return previous;
      const selected = resolveModelStarterSelection(this.db, input);
      const prepared = prepareModelStarterTaskset(selected);
      await materializeImmutableTasksetPackage(this.home, prepared, prepared.taskset.id);
      return commitModelStarterCreation(this.db, selected);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async prepareModelStarterCreation(input: ModelStarterCommitInput) {
    await this.ready;
    await this.writeQueue;
    if (!this.db) throw new Error("Starter check failed because the local store is closed.");
    return prepareModelStarterTaskset(resolveModelStarterSelection(this.db, input));
  }

  async saveModelProjectHosting(previous: ModelProject | null, next: ModelProject, replace = false): Promise<ModelProject> {
    await this.ready;
    const operation = this.writeQueue.then(() => {
      if (!this.db) throw new Error("Model synchronization failed because the local store is closed.");
      return commitModelProjectHosting(this.db, previous, next, replace);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
