import { hostedCliFetch } from "./common/hosted-cli-fetch";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import { captureTasksetDraftWorkspace } from "@openpond/taskset-sdk";
import { DatasetPopulationQuerySchema, OpenPondDatasetImportClient, OpenPondDatasetPopulationClient, OpenPondDatasetWorkspaceClient, compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import { loadConfig } from "../config";
import { ensureApiKey, optionString, resolveAccountOption, resolveApiBaseUrlOption, resolveBaseUrlOption, resolveBaseUrl, parseBooleanOption } from "./common";
import { DATASET_PREPARATION_USAGE, runDatasetPreparationCommand } from "./datasets-preparation";
import { runLocalDatasetsCommand } from "./datasets-local";
import { isDatasetTransferAction, runDatasetTransferCommand } from "./datasets-transfer";
import { isDatasetVersionAction, runDatasetVersionCommand } from "./datasets-versions";
import { readFile } from "node:fs/promises";

export async function runDatasetsCommand(options: Record<string, string | boolean>, rest: string[]) {
  if (parseBooleanOption(options.local)) return runLocalDatasetsCommand(options,rest);
  const [action, id] = rest;
  const teamId = optionString(options, "team"); const baseUrl = resolveApiBaseUrlOption(options);
  if (action === "preparation") {
    if (!teamId || !baseUrl) throw new Error(`usage: ${DATASET_PREPARATION_USAGE}`);
    const config = await loadConfig();
    const client = new OpenPondDatasetWorkspaceClient({ teamId, baseUrl, fetch: hostedCliFetch, apiKey: await ensureApiKey(config, resolveBaseUrl(config)) });
    return runDatasetPreparationCommand(client.preparations, options, rest.slice(1));
  }
  if (action === "population" || isDatasetTransferAction(action) || isDatasetVersionAction(action)) {
    if (!teamId || !baseUrl || rest.length > 2)
      throw new Error("Use --team and --api-base-url with hosted dataset commands.");
    const account = resolveAccountOption(options);
    const accountBase = resolveBaseUrlOption(options);
    const context = await loadOpenPondAccountContext(account, accountBase);
    if ((account || accountBase) && (!context.account || !context.token || !account))
      throw new Error("Select a signed-in account with --account for the requested API origin.");
    const matchingToken = context.account && new URL(context.apiBaseUrl).origin === new URL(baseUrl).origin
      ? context.token : null;
    if ((account || accountBase) && !matchingToken)
      throw new Error("The API URL must match the selected account's API origin.");
    let apiKey = account ? matchingToken : process.env.OPENPOND_API_KEY?.trim() || matchingToken;
    if (!apiKey) {
      if (context.account) throw new Error("Select an account for the requested API origin or supply an API key for that origin.");
      const config = await loadConfig();
      apiKey = await ensureApiKey(config, resolveBaseUrl(config));
    }
    if (action === "population") {
      const revision = optionString(options, "versionRevision");
      const contentHash = optionString(options, "packageHash");
      const limit = optionString(options, "limit");
      if (!id || !revision || !contentHash)
        throw new Error("Provide the dataset ID, --version-revision and --package-hash from the published version.");
      const query = DatasetPopulationQuerySchema.parse({
        release: { id, revision: Number(revision), contentHash },
        view: optionString(options, "view") || undefined,
        afterId: optionString(options, "cursor") || undefined,
        limit: limit ? Number(limit) : undefined,
      });
      const client = new OpenPondDatasetPopulationClient({ teamId, baseUrl, fetch: hostedCliFetch, apiKey });
      console.log(JSON.stringify(await client.read(query), null, 2));
      return;
    }
    if (isDatasetVersionAction(action)) {
      const client = new OpenPondDatasetWorkspaceClient({ teamId, baseUrl, fetch: hostedCliFetch, apiKey });
      console.log(JSON.stringify(await runDatasetVersionCommand(client, action, id, options), null, 2));
      return;
    }
    const client = new OpenPondDatasetImportClient({
      teamId, baseUrl, fetch: hostedCliFetch, apiKey,
    });
    console.log(JSON.stringify(await runDatasetTransferCommand(client, action, id, options), null, 2));
    return;
  }
  if (!teamId || !baseUrl || !action || rest.length > 2 || !["upload", "save", "read", "list", "validate", "publish"].includes(action))
    throw new Error("usage: datasets <upload|save|read|list|validate|publish> [folder|id] --team <id> --api-base-url <origin> [--input-file <path>] [--operation-id <id>] [--expected-revision <n>] [--publish] [--project <id>]");
  const config = await loadConfig();
  const client = new OpenPondDatasetWorkspaceClient({ teamId, baseUrl, fetch: hostedCliFetch, apiKey: await ensureApiKey(config, resolveBaseUrl(config)) });
  const operationId = optionString(options, "operationId");
  let result: unknown;
  if (action === "save") {
    const file = optionString(options, "inputFile");
    if (id || !file) throw new Error("Save requires --input-file containing the complete Dataset workspace write request, including its operationId and expectedRevision.");
    result = await client.save(JSON.parse(await readFile(file, "utf8")));
  } else if (action === "list") {
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
