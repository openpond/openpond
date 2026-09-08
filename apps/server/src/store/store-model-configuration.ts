import path from "node:path";
import type { ModelProject, Taskset } from "@openpond/contracts";
import { hashTasksetDraftPackage } from "@openpond/taskset-sdk";
import { SqliteTasksetDraftStore } from "./store-taskset-drafts.js";
import type { ModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { commitModelProjectSave, findModelProjectSave } from "./store-model-project-authoring.js";
import { commitModelStarterCreation, findModelStarterCreation, type ModelStarterCommitInput } from "./store-model-starters.js";
import { commitModelProjectHosting } from "./store-model-project-hosting.js";
import { prepareModelTasksetSave } from "./store-model-taskset-derivation.js";
import { materializeImmutableTasksetPackage } from "../training/model-starter-package-files.js";
import { prepareModelStarterTaskset } from "../training/model-starter-taskset.js";
import { resolveModelStarterSelection } from "./store-model-starter-selection.js";
import { tasksetPackageDirectoryId } from "../training/taskset-package-path.js";
import { verifyPublishedTasksetAssets } from "../training/taskset-package-assets.js";
import { cacheTasksetPackage, materializeImportedTasksetPackage } from "../training/taskset-package-files.js";
import type { PreparedImportedTasksetPackage } from "../training/taskset-package-import.js";
import { importTasksetPackageInTransaction } from "./store-taskset-package-import.js";
import { loadModelTasksetPackage } from "./store-model-taskset-package.js";
import { completeModelPackageOperation, pendingModelPackageOperation, prepareModelPackageOperation, type ModelPackageOperation, type ModelPackageScope } from "./store-model-package-operations.js";
import type { TasksetPackageReceipt } from "openpond-sdk/taskset-packages";

/** Model configuration, starter publication and hosting share the store write queue. */
export class SqliteModelConfigurationStore extends SqliteTasksetDraftStore {
  async pendingModelPackagePush(scope: ModelPackageScope) {
    await this.ready;
    await this.writeQueue;
    if (!this.db) throw new Error("Package push store is closed.");
    return pendingModelPackageOperation(this.db, scope);
  }

  async prepareModelPackagePush(input: ModelPackageOperation) {
    await this.ready;
    const operation = this.writeQueue.then(() => {
      if (!this.db) throw new Error("Package push store is closed.");
      return prepareModelPackageOperation(this.db, input);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async completeModelPackagePush(operationId: string, receipt: TasksetPackageReceipt) {
    await this.ready;
    const operation = this.writeQueue.then(() => {
      if (!this.db) throw new Error("Package push store is closed.");
      return completeModelPackageOperation(this.db, operationId, receipt);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async rejectModelPackagePush(operationId: string) {
    await this.ready;
    const operation = this.writeQueue.then(() => {
      if (!this.db) throw new Error("Package push store is closed.");
      this.db.run("UPDATE model_project_package_operations SET state = 'rejected' WHERE operation_id = ? AND state = 'pending'", [operationId]);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

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
      const prepared = prepareModelTasksetSave(this.db, request, true, await loadModelTasksetPackage(this.db, this.home, request));
      if (prepared?.imported) {
        await materializeImportedTasksetPackage({ home: this.home, ...prepared.imported });
      } else if (prepared) {
        const sourceDirectory = path.join(this.home, "training", "tasksets", tasksetPackageDirectoryId(prepared.source));
        await materializeImmutableTasksetPackage(this.home, prepared, prepared.directoryId, {
          source: { directory: sourceDirectory, packageHash: await hashTasksetDraftPackage(sourceDirectory) },
          verify: directory => verifyPublishedTasksetAssets(directory, prepared.taskset),
        });
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
    return prepareModelTasksetSave(this.db, request, false, await loadModelTasksetPackage(this.db, this.home, request))?.taskset ?? null;
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

  async saveModelProjectHosting(previous: ModelProject | null, next: ModelProject, replace = false, packages: PreparedImportedTasksetPackage[] = []): Promise<ModelProject> {
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      if (!this.db) throw new Error("Model synchronization failed because the local store is closed.");
      if (packages.length && !replace) throw new Error("Package import requires an atomic Model replacement.");
      for (const prepared of packages) {
        if (prepared.taskset.profileId !== next.profileId) throw new Error("Imported package belongs to another Profile.");
        if (prepared.reuseExisting) await cacheTasksetPackage(this.home, prepared.package);
        else await materializeImportedTasksetPackage({ home: this.home, ...prepared });
      }
      return commitModelProjectHosting(this.db, previous, next, replace, () => {
        for (const prepared of packages) importTasksetPackageInTransaction(this.db!, prepared);
      });
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
