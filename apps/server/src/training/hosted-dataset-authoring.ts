import { z } from "zod";
import { saveRecoveredDatasetWrite } from "./hosted-dataset-recovery.js";
import { captureTasksetDraftWorkspace } from "@openpond/taskset-sdk";
import { contentHash } from "@openpond/harness";
import { OpenPondDatasetWorkspaceClient, type DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import { createTasksetDraft, createTasksetDraftWorkspace, saveTasksetDraftWorkspaceDocument, saveTasksetDraftWorkspaceFile, listTasksetDraftWorkspaceFiles, readTasksetDraftWorkspaceFile, publishTasksetDraft, type TasksetDraft } from "openpond-sdk/taskset-drafts";
const Id = z.string().trim().min(1).max(240);
export async function hostedDatasetAuthoring(input: { client: OpenPondDatasetWorkspaceClient; teamId: string; projectId: string | null; ownerScope?: "workspace" | "personal"; operation: string; value: unknown; requireDataset: (id: string) => Promise<DatasetWorkspaceReceipt> }) {
  const scope = { ...(input.projectId ? { originProjectId: input.projectId } : {}), ...(input.ownerScope ? { ownerScope: input.ownerScope } : {}) };
  if (input.operation === "uploadFolder") {
    const request = z.object({ directory: z.string().min(1), operationId: Id }).strict().parse(input.value);
    const recovered = await input.client.operationResult(request.operationId, { kind: "create" });
    if (recovered) { await input.requireDataset(recovered.receipt.datasetId); return recovered.receipt; }
    const captured = await captureTasksetDraftWorkspace({ directory: request.directory, teamId: input.teamId, expectedRevision: 0 });
    return input.client.save({ ...scope, operationId: request.operationId, expectedRevision: 0, workspace: captured.workspace });
  }
  if (input.operation === "createDraft") {
    const request = z.object({ id: Id, operationId: Id, name: z.string().max(200), now: z.iso.datetime() }).strict().parse(input.value);
    const draft = createTasksetDraft({ id: request.id, profileId: input.teamId, name: request.name, now: request.now });
    const recovered = await input.client.operationResult(request.operationId, { datasetId: request.id, kind: "create" });
    if (recovered) await input.requireDataset(request.id);
    return saveRecoveredDatasetWrite(input.client, { ...scope, operationId: request.operationId, expectedRevision: 0, workspace: createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft, files: [] }) }, recovered);
  }
  const request = z.object({ id: Id, operationId: Id.optional(), now: z.iso.datetime().optional(), draft: z.unknown().optional(), mutation: z.unknown().optional(), path: z.string().optional() }).strict().parse(input.value);
  const current = await input.requireDataset(request.id);
  const recovered = ["saveDraft", "saveDraftFile", "publishDraft"].includes(input.operation) ? await input.client.operationResult(Id.parse(request.operationId), { datasetId: request.id, kind: input.operation === "publishDraft" ? "publish" : "save" }) : null;
  const receipt = recovered?.base ?? current;
  if (input.operation === "draftFiles") return listTasksetDraftWorkspaceFiles(receipt.workspace);
  if (input.operation === "draftFile") return readTasksetDraftWorkspaceFile(receipt.workspace, z.string().parse(request.path));
  if (input.operation === "saveDraft" || input.operation === "saveDraftFile") {
    const now = z.iso.datetime().parse(request.now);
    const workspace = input.operation === "saveDraft" ? saveTasksetDraftWorkspaceDocument({ workspace: receipt.workspace, draft: request.draft, expectedDraftRevision: receipt.revision, now }) : saveTasksetDraftWorkspaceFile({ workspace: receipt.workspace, mutation: request.mutation as Parameters<typeof saveTasksetDraftWorkspaceFile>[0]["mutation"], now });
    return saveRecoveredDatasetWrite(input.client, { ...(receipt.originProjectId ? { originProjectId: receipt.originProjectId } : {}), ...(receipt.ownerScope ? { ownerScope: receipt.ownerScope } : {}), expectedRevision: receipt.revision, operationId: Id.parse(request.operationId), workspace }, recovered);
  }
  if (input.operation === "publishDraft") {
    const validated = recovered ? { workspaceHash: receipt.workspace.contentHash, packageHash: recovered.receipt.publication!.packageHash } : await input.client.validate(receipt.datasetId, receipt.revision);
    const publicationRequest = { operationId: Id.parse(request.operationId), expectedRevision: receipt.revision, workspaceHash: validated.workspaceHash, packageHash: validated.packageHash };
    if (recovered && contentHash({ id: receipt.datasetId, publish: publicationRequest }) !== recovered.requestHash) throw new Error("This operation ID was used for another Dataset publication.");
    const published = recovered?.receipt ?? await input.client.publish(receipt.datasetId, publicationRequest);
    // Same authored projection for the editor callback; the hosted publication
    // receipt is authoritative and launches no compute or local model version.
    const taskset = publishTasksetDraft({ draft: receipt.workspace.draft, now: receipt.workspace.draft.updatedAt, sourcePackageHash: receipt.workspace.contentHash });
    if (!published.publication) throw new Error("Hosted publication has no retained release.");
    return { draft: published.workspace.draft as TasksetDraft, taskset, hostedSync: { state: "synced", error: null }, publication: published.publication, sourceHash: contentHash(receipt.workspace) };
  }
  throw new Error("Unsupported hosted dataset authoring operation.");
}
