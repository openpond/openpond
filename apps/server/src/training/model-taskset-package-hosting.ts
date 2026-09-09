import { contentHash } from "@openpond/harness";
import { learningRef } from "@openpond/evals/learning";
import type { ModelProject, Taskset } from "@openpond/contracts";
import type { TasksetRelease } from "@openpond/evals/tasksets";
import { OpenPondTasksetPackageClient, OpenPondTasksetPackageError, TasksetPackageModelConfigurationSchema, type TasksetPackagePublication } from "openpond-sdk/taskset-packages";
import type { SqliteStore } from "../store/store.js";
import type { ModelPackageOperation } from "../store/store-model-package-operations.js";
import { exportLocalModelTasksetPackage } from "./model-taskset-package-export.js";
import { cacheTasksetPackage, readCachedTasksetPackage } from "./taskset-package-files.js";
import { hostedModelProjectTrainingSetup } from "./model-project-hosted-projection.js";
import { buildIntent, requireProject } from "./model-project-hosting-utils.js";

export type ModelPackageHostedAccess = { apiBaseUrl: string; token: string; teamId: string };

/** Persist intent before transport and commit its receipt with the hosted link.
 * Retrying first finishes any earlier accepted push, preserving newer edits. */
export async function pushModelTasksetPackage(input: {
  store: SqliteStore; projectId: string; access: ModelPackageHostedAccess; fetch: typeof fetch;
  attachment?: { taskset: Taskset; release: TasksetRelease };
}): Promise<ModelProject> {
  const apiOrigin = new URL(input.access.apiBaseUrl).origin;
  const client = new OpenPondTasksetPackageClient({ baseUrl: input.access.apiBaseUrl, apiKey: input.access.token, teamId: input.access.teamId, fetch: input.fetch });
  const finish = async (operation: ModelPackageOperation) => {
    const value = await readCachedTasksetPackage(input.store.home, operation.packageHash);
    const evaluationPackage = operation.evaluationPackageHash ? await readCachedTasksetPackage(input.store.home, operation.evaluationPackageHash) : undefined;
    let receipt;
    try { receipt = await client.publish({ ...operation.request, package: value, ...(evaluationPackage ? { evaluationPackage } : {}) }); }
    catch (error) {
      // A definitive rejection committed no receipt. Network failures and
      // observation timeouts remain pending and replay the identical request.
      if (error instanceof OpenPondTasksetPackageError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) await input.store.rejectModelPackagePush(operation.request.operationId);
      throw error;
    }
    return input.store.completeModelPackagePush(operation.request.operationId, receipt);
  };
  for (;;) {
    const project = await requireProject(input.store, input.projectId);
    if (project.hosted && (project.hosted.apiOrigin !== apiOrigin || project.hosted.teamId !== input.access.teamId)) throw new Error("Pull this Model from its linked API and workspace before pushing local changes.");
    const pending = await input.store.pendingModelPackagePush({ profileId: project.profileId, modelId: project.id, apiOrigin, teamId: input.access.teamId });
    if (pending) { await finish(pending); continue; }
    const reference = input.attachment ? learningRef(input.attachment.taskset) : project.trainingSetup.tasksetRef;
    if (!reference) throw new Error("Select a published Taskset before pushing its package.");
    const selected = project.trainingSetup.tasksetRef;
    const selecting = !input.attachment || (selected?.id === reference.id && selected.revision === reference.revision && selected.contentHash === reference.contentHash);
    const matching = project.hosted?.tasksets.find(link => link.localTasksetId === reference.id && link.localTasksetHash === reference.contentHash && link.packageHash);
    const evaluationReference = selecting ? project.trainingSetup.evaluationTasksetRef : null;
    const evaluationMatching = !evaluationReference || project.hosted?.tasksets.some(link => link.localTasksetId === evaluationReference.id && link.localTasksetHash === evaluationReference.contentHash && link.packageHash);
    if (matching && evaluationMatching && (!selecting || project.hosted!.syncedSourceRevision === project.revision)) return project;
    // A historical attachment cannot create or retarget the Model. Publish its
    // actual current selection first when this Model has not been hosted yet.
    if (!selecting && !project.hosted) {
      await pushModelTasksetPackage({ ...input, attachment: undefined });
      continue;
    }
    const value = await exportLocalModelTasksetPackage({ store: input.store, storeDir: input.store.home,
      profileId: project.profileId, modelId: project.id, tasksetRef: reference });
    const evaluationPackage = evaluationReference ? await exportLocalModelTasksetPackage({ store: input.store, storeDir: input.store.home,
      profileId: project.profileId, modelId: project.id, tasksetRef: evaluationReference }) : undefined;
    if (input.attachment && contentHash(learningRef(value.taskset)) !== contentHash(learningRef(input.attachment.release))) throw new Error("Requested historical release differs from its complete local package.");
    const taskset = await input.store.getTasksetRevision(reference.id, reference.revision, reference.contentHash);
    if (!taskset) throw new Error("The published Taskset is unavailable.");
    const { tasksetRef: _tasksetRef, rewardBindingRef: _binding, tasksetRelease: _release, evaluationTasksetRef: _evaluationRef, ...trainingSetup } = hostedModelProjectTrainingSetup(project.trainingSetup);
    const modelConfiguration = selecting ? TasksetPackageModelConfigurationSchema.parse({ portableProjectId: project.id,
      name: project.name, objective: project.objective, defaultBaseModel: project.defaultBaseModel, defaultDestinationId: project.defaultDestinationId,
      sourceRevision: project.revision, sourceUpdatedAt: project.updatedAt, trainingSetup: { ...trainingSetup, evaluationTasksetRef: evaluationPackage ? learningRef(evaluationPackage.taskset) : null } }) : undefined;
    const requestContent = {
      schemaVersion: "openpond.tasksetPackagePublication.v1" as const, modelProjectId: project.id,
      expectedProjectEtag: project.hosted?.etag ?? null, name: taskset.name, description: taskset.objective,
      buildIntent: buildIntent(taskset), methodHint: null,
      selection: selecting ? "select" as const : "attach" as const,
      ...(modelConfiguration ? { modelConfiguration } : {}),
    };
    const operationId = `package-push:${contentHash({ apiOrigin, teamId: input.access.teamId, request: requestContent, packageHash: value.contentHash, evaluationPackageHash: evaluationPackage?.contentHash ?? null })}`;
    const request: Omit<TasksetPackagePublication, "package" | "evaluationPackage"> = { ...requestContent, operationId };
    await cacheTasksetPackage(input.store.home, value);
    if (evaluationPackage) await cacheTasksetPackage(input.store.home, evaluationPackage);
    const operation = await input.store.prepareModelPackagePush({ apiOrigin, teamId: input.access.teamId, project,
      localTaskset: reference, packageHash: value.contentHash, request,
      ...(evaluationReference && evaluationPackage ? { localEvaluation: evaluationReference, evaluationPackageHash: evaluationPackage.contentHash } : {}) });
    const saved = await finish(operation);
    if (operation.request.operationId === operationId) return saved;
    // Another window prepared an earlier operation. Its receipt is now durable;
    // resolve our requested selection against the updated local Model.
  }
}
