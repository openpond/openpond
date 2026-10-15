import { contentHash } from "@openpond/harness";
import { compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import { prepareImportedTasksetPackage } from "openpond-sdk/taskset-packages";
import { LocalModelProjectPreparationInputSchema, parseLocalModelProjectPreparation, prepareLocalModelProject, type LocalModelProjectPreparationInput } from "../training/local-model-project-preparation.js";
import { materializeImportedTasksetPackage } from "../training/taskset-package-files.js";
import { SqliteStoreDomain } from "./store-domain.js";
import { hydrateLocalDatasetRecord } from "./store-local-dataset-storage.js";
import { findModelProjectSave, saveModelProjectInTransaction } from "./store-model-project-authoring.js";
import { importTasksetPackageInTransaction } from "./store-taskset-package-import.js";

/** A single local publication owner; the dry run never materializes files or writes rows. */
export class SqliteModelProjectPreparationStore extends SqliteStoreDomain {
  private async compile(request: LocalModelProjectPreparationInput) {
    const owner = this.database.get<{ id: string }>("SELECT id FROM local_resource_owner WHERE singleton=1", []);
    const row = this.database.get<{ payload: string }>("SELECT r.payload FROM local_dataset_versions w JOIN local_dataset_records r ON r.record_hash=w.record_hash WHERE w.id=? AND w.revision=?", [request.source.datasetId, request.source.revision]);
    if (!row || !owner || owner.id !== request.source.ownerId) throw new Error("Dataset is unavailable on the selected local owner.");
    const record = hydrateLocalDatasetRecord(this.database, row.payload);
    if (record.ownerId !== owner.id || record.workspace.contentHash !== request.source.workspaceHash) throw new Error("Dataset owner or workspace changed since preparation was requested.");
    const source = compileTasksetDraftWorkspace({ workspace: record.workspace, preparation: null,
      adapterId: "openpond-desktop-taskset-authoring-v1", now: record.workspace.draft.updatedAt });
    return prepareLocalModelProject({ request, source, createdAt: record.workspace.draft.updatedAt, name: record.workspace.draft.name });
  }

  async prepareLocalModelProject(raw: unknown) {
    const request = LocalModelProjectPreparationInputSchema.parse(raw);
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      if (this.database.get("SELECT id FROM model_projects WHERE id=?", [request.project.id])) throw new Error("Model Project already exists; preparation only creates a distinct Model.");
      return this.compile(request);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async applyLocalModelProjectPreparation(raw: unknown) {
    const receipt = parseLocalModelProjectPreparation(raw);
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      const current = await this.compile(receipt.request);
      if (contentHash(current) !== contentHash(receipt)) throw new Error("Project preparation differs from the exact source, Reward closure or recipe. Prepare and review it again.");
      const prior = findModelProjectSave(this.database, receipt.saveRequest);
      if (prior) return { project: prior, taskset: receipt.taskset, packageHash: receipt.package.contentHash, preparationHash: receipt.contentHash };
      if (this.database.get("SELECT id FROM model_projects WHERE id=?", [receipt.request.project.id])) throw new Error("Model Project already exists with a different preparation.");
      const prepared = prepareImportedTasksetPackage({ package: receipt.package, profileId: receipt.request.project.profileId,
        name: receipt.taskset.name, createdAt: receipt.taskset.createdAt });
      if (contentHash(prepared.taskset) !== contentHash(receipt.taskset)) throw new Error("Project preparation projection changed.");
      await materializeImportedTasksetPackage({ home: this.home, ...prepared });
      // No await can split publication. Any resource/model conflict rolls back all rows.
      this.database.exec("BEGIN IMMEDIATE");
      try {
        importTasksetPackageInTransaction(this.database, prepared);
        const project = saveModelProjectInTransaction(this.database, receipt.saveRequest, null, receipt.package);
        this.database.exec("COMMIT");
        return { project, taskset: prepared.taskset, packageHash: prepared.package.contentHash, preparationHash: receipt.contentHash };
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
