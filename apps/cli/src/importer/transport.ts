import { sha256, contentHash } from "@openpond/harness";
import {
  ConnectedEvidenceClient,
  ConnectedSyncClient,
  AgentImportReceiptSchema,
} from "openpond-sdk/connected-evidence";
import {
  collectorDestinations,
  type CollectorConnection,
  type CollectorTransport,
} from "@openpond/evals/native-conversations";
import { loadConfig } from "../config";
import { resolveApiKey } from "../cli/common/auth";
import { withOpenPondHome } from "@openpond/persistence";
import { homedir } from "node:os";
import { join } from "node:path";
export async function collectorClients(
  connection: Pick<
    CollectorConnection,
    "teamId" | "apiBaseUrl" | "account" | "accountBaseUrl" | "credentialHome"
  >,
) {
  const config = await withOpenPondHome(connection.credentialHome ?? join(homedir(), ".openpond"), () => loadConfig({
      account: connection.account,
      baseUrl: connection.accountBaseUrl,
    })),
    apiKey = connection.account ? config.apiKey : resolveApiKey(config);
  if (!apiKey)
    throw Object.assign(
      new Error("This source is disconnected. Reconnect it with OpenPond Importer to authorize collection."),
      { status: 401 },
    );
  const options = {
    apiKey,
    baseUrl: connection.apiBaseUrl,
    teamId: connection.teamId,
  };
  return {
    evidence: new ConnectedEvidenceClient(options),
    sync: new ConnectedSyncClient(options),
  };
}
// One bounded worker owns this cache. A timed-out upload resumes at its next
// acknowledged part; consecutive batches reuse the same immutable upload.
let cachedUpload: {
  key: string;
  bytes: Buffer;
  upload: { hash: string; parts: number };
  nextPart: number;
  preview?: Awaited<ReturnType<ConnectedEvidenceClient["preview"]>>;
} | null = null;

export const collectorTransport: CollectorTransport = {
  async publishCoverage(connection, manifest, cancellation) {
    const { sync } = await collectorClients(connection);
    await sync.publishCoverage({ id: connection.id, expectedRevision: connection.revision, manifest },
      AbortSignal.any([AbortSignal.timeout(60000), ...(cancellation ? [cancellation] : [])]));
  },
  async heartbeat(connection, input, cancellation) {
    const { sync } = await collectorClients(connection);
    const remote = await sync.heartbeat({
      id: connection.id,
      expectedRevision: connection.revision,
      ...input,
    }, AbortSignal.any([AbortSignal.timeout(60000), ...(cancellation ? [cancellation] : [])]));
    return { revision: remote.revision, state: remote.state, destinations: collectorDestinations(connection, remote), requestedSyncRevision: remote.requestedSyncRevision, completedSyncRevision: remote.completedSyncRevision };
  },
  async admit(connection, entry, cancellation) {
    const { evidence, sync } = await collectorClients(connection),
      signal = AbortSignal.any([AbortSignal.timeout(60000), ...(cancellation ? [cancellation] : [])]);
    const key = contentHash([connection.id, connection.revision, connection.apiBaseUrl, connection.teamId, connection.account,
      connection.credentialHome, connection.projectId, connection.source.instanceId, entry.branchLeafId, entry.files]);
    if (cachedUpload?.key !== key) {
      const bytes = Buffer.from(JSON.stringify(entry.files.map(file => ({
        path: file.path, encoding: "utf8", base64: Buffer.from(file.text).toString("base64"),
      }))));
      cachedUpload = { key, bytes, upload: { hash: sha256(bytes), parts: Math.ceil(bytes.length / 200000) }, nextPart: 0 };
    }
    const retained = cachedUpload;
    const upload = retained.upload;
    while (retained.nextPart < upload.parts) {
      const index = retained.nextPart;
      await evidence.uploadPart({ ...upload, index,
        base64: retained.bytes.subarray(index * 200000, (index + 1) * 200000).toString("base64"),
      }, signal);
      retained.nextPart++;
    }
    const input = {
      upload,
      source: connection.source.source,
      ...(entry.branchLeafId ? { branchLeafId: entry.branchLeafId } : {}),
      destination: {
        kind: "existing" as const,
        projectId: connection.projectId,
      },
      acquisition: {
        machineId: connection.source.machineId,
        sourceInstanceId: connection.source.instanceId,
      },
    };
    const preview = retained.preview ??= await evidence.preview(input, signal);
    if (preview.issues.length)
      throw Object.assign(
        new Error(
          "Source schema was rejected; inspect the connection before resuming.",
        ),
        { status: 400 },
      );
    const session = preview.sessions.find(
      (item) => item.sessionHash === entry.contentHash,
    );
    if (
      !session ||
      entry.boundaryIds.some(
        (id) =>
          !session.boundaries.some(
            (boundary) =>
              boundary.id === id &&
              boundary.projection === "turn" &&
              boundary.terminal !== "unknown",
          ),
      )
    )
      throw Object.assign(
        new Error(
          "Server preview differs from the retained source boundaries.",
        ),
        { status: 400 },
      );
    const request = {
      ...input,
      operationId: entry.operationId,
      previewHash: preview.previewHash,
      selection: [
        { sessionHash: session.sessionHash, boundaryIds: entry.boundaryIds },
      ],
    };
    const result = AgentImportReceiptSchema.parse(
      await sync.commit(
        {
          connectionId: connection.id,
          expectedRevision: connection.revision,
          request,
        },
        signal,
      ),
    );
    if (
      result.state !== "completed" ||
      result.operationId !== entry.operationId ||
      result.requestHash !== contentHash(request) ||
      result.projectId !== connection.projectId
    )
      throw new Error("Admission did not acknowledge this retained operation.");
  },
};
