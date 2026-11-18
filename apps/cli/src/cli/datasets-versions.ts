import { DatasetWorkspaceRowsQuerySchema, type OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import { optionString } from "./common";
import { exportPublishedDatasetRows } from "./dataset-row-export";

const actions = ["rows", "sources", "export-rows", "validate-version", "create-version", "version-manifest", "begin-version"] as const;
type Action = (typeof actions)[number];
export function isDatasetVersionAction(value: string | undefined): value is Action {
  return actions.some(action => action === value);
}

export async function runDatasetVersionCommand(
  client: OpenPondDatasetWorkspaceClient,
  action: Action,
  id: string | undefined,
  options: Record<string, string | boolean>,
) {
  if (!id) throw new Error("Provide the saved dataset ID.");
  const parsedRevision = (name: string) => {
    const value = Number(optionString(options, name));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Provide a positive dataset revision.");
    return value;
  };
  if (action === "export-rows") {
    const outputFile = optionString(options, "outputFile");
    if (!outputFile) throw new Error("Provide --output-file for the NDJSON export.");
    if (optionString(options, "revision") || optionString(options, "cursor") || optionString(options, "limit"))
      throw new Error("Export requires a published version and reads the complete selection.");
    const split = optionString(options, "split");
    const { splits, fileId, limit } = DatasetWorkspaceRowsQuerySchema.parse({
      splits: split ? split.split(",") : undefined,
      fileId: optionString(options, "fileId") || undefined,
      limit: 100,
    });
    return exportPublishedDatasetRows(client, {
      datasetId: id, revision: parsedRevision("versionRevision"), outputFile, query: { splits, fileId, limit },
    });
  }
  if (action === "rows") {
    const revision = optionString(options, "revision");
    const version = optionString(options, "versionRevision");
    if (revision && version) throw new Error("Choose --revision or --version-revision.");
    const split = optionString(options, "split");
    const limit = optionString(options, "limit");
    const query = DatasetWorkspaceRowsQuerySchema.parse({
      revision: revision ? Number(revision) : undefined,
      splits: split ? split.split(",") : undefined,
      fileId: optionString(options, "fileId") || undefined,
      cursor: optionString(options, "cursor") || undefined,
      limit: limit ? Number(limit) : undefined,
    });
    if (version) return client.versionRows(id, parsedRevision("versionRevision"), {
      splits: query.splits, fileId: query.fileId, cursor: query.cursor, limit: query.limit,
    });
    return client.rows(id, query);
  }
  if (action === "sources") {
    const revision = optionString(options, "revision");
    const version = optionString(options, "versionRevision");
    if (revision && version) throw new Error("Choose --revision or --version-revision.");
    return version
      ? client.versionSources(id, parsedRevision("versionRevision"))
      : client.sources(id, { revision: revision ? parsedRevision("revision") : undefined });
  }
  if (action === "version-manifest") return client.versionManifest(id, parsedRevision("versionRevision"));
  const expectedRevision = parsedRevision("expectedRevision");
  if (action === "validate-version") return client.validateVersion(id, expectedRevision);
  const operationId = optionString(options, "operationId");
  if (!operationId) throw new Error("Provide a stable --operation-id and reuse it on retry.");
  if (action === "begin-version") return client.beginVersion(id, { operationId, expectedRevision });
  const workspaceHash = optionString(options, "workspaceHash");
  const indexHash = optionString(options, "indexHash");
  const packageHash = optionString(options, "packageHash");
  if (!workspaceHash || !indexHash || !packageHash)
    throw new Error("Provide --workspace-hash, --index-hash and --package-hash from validation.");
  return client.createVersion(id, { operationId, expectedRevision, workspaceHash, indexHash, packageHash });
}
