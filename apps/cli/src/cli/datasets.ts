import { captureTasksetDraftWorkspace } from "@openpond/taskset-sdk";
import { OpenPondDatasetWorkspaceClient, compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import { loadConfig } from "../config";
import { ensureApiKey, optionString, resolveApiBaseUrlOption, resolveBaseUrl, parseBooleanOption } from "./common";

export async function runDatasetsCommand(options: Record<string, string | boolean>, rest: string[]) {
  const [action, id] = rest;
  const teamId = optionString(options, "team"); const baseUrl = resolveApiBaseUrlOption(options);
  if (!teamId || !baseUrl || !action || rest.length > 2 || !["upload", "read", "list", "validate", "publish"].includes(action))
    throw new Error("usage: datasets <upload|read|list|validate|publish> [folder|id] --team <id> --api-base-url <origin> [--operation-id <id>] [--expected-revision <n>] [--publish] [--project <id>]");
  const config = await loadConfig();
  const client = new OpenPondDatasetWorkspaceClient({ teamId, baseUrl, apiKey: await ensureApiKey(config, resolveBaseUrl(config)) });
  const operationId = optionString(options, "operationId");
  let result: unknown;
  if (action === "list") {
    if (id) throw new Error("List does not accept a dataset id.");
    result = await client.list({ cursor: optionString(options, "cursor") || undefined });
  } else {
    if (!id) throw new Error(`${action} requires a ${action === "upload" ? "folder" : "dataset id"}.`);
    if (action === "read") result = await client.get(id);
    else if (action === "upload") {
      if (!operationId || operationId.length > 220) throw new Error("Upload requires a stable --operation-id of at most 220 characters. Reuse it after an uncertain response.");
      const revision = optionString(options, "expectedRevision");
      const expectedRevision = revision ? Number(revision) : 0;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Expected revision must be a nonnegative integer.");
      const captured = await captureTasksetDraftWorkspace({ directory: id, teamId, expectedRevision, datasetId: optionString(options, "datasetId") || undefined });
      const compiled = compileTasksetDraftWorkspace({ workspace: captured.workspace, preparation: null, adapterId: "openpond-hosted-taskset-authoring-v1", now: captured.workspace.draft.updatedAt });
      const saved = await client.save({ operationId: `${operationId}:save`, expectedRevision, workspace: captured.workspace,
        ...(optionString(options, "project") ? { originProjectId: optionString(options, "project") } : {}) });
      const current = await client.get(saved.datasetId);
      if (current.workspace.draft.status === "draft") {
        const validation = await client.validate(saved.datasetId, saved.revision);
        if (validation.workspaceHash !== captured.workspace.contentHash || validation.packageHash !== compiled.contentHash)
          throw new Error("Hosted validation differs from the captured folder bytes.");
      } else if (current.publication?.packageHash !== compiled.contentHash) throw new Error("This dataset was changed after the upload receipt. Read the current version before continuing.");
      const receipt = parseBooleanOption(options.publish) ? await client.publish(saved.datasetId, {
        operationId: `${operationId}:publish`, expectedRevision: saved.revision, workspaceHash: saved.workspace.contentHash, packageHash: compiled.contentHash,
      }) : saved;
      result = { teamId, datasetId: receipt.datasetId, revision: receipt.revision, status: receipt.workspace.draft.status,
        operationId, capturedBytes: captured.capturedBytes, sourceHash: captured.sourceHash, sourceFiles: captured.sourceFiles,
        workspaceHash: saved.workspace.contentHash, packageHash: compiled.contentHash, publication: receipt.publication };
    } else {
      const expectedRevision = Number(optionString(options, "expectedRevision"));
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) throw new Error(`${action} requires --expected-revision with the retained dataset revision.`);
      if (action === "validate") result = await client.validate(id, expectedRevision);
      else {
        if (!operationId) throw new Error("Publish requires a stable --operation-id.");
        const workspaceHash = optionString(options, "workspaceHash"); const packageHash = optionString(options, "packageHash");
        if (!workspaceHash || !packageHash) throw new Error("Publish requires --workspace-hash and --package-hash from the retained validation receipt. Keep these pins and the operation id unchanged on retry.");
        result = await client.publish(id, { operationId, expectedRevision, workspaceHash, packageHash });
      }
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
