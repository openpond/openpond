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
export async function collectorClients(
  connection: Pick<
    CollectorConnection,
    "teamId" | "apiBaseUrl" | "account" | "accountBaseUrl"
  >,
) {
  const config = await loadConfig({
      account: connection.account,
      baseUrl: connection.accountBaseUrl,
    }),
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
export const collectorTransport: CollectorTransport = {
  async pause(connection) {
    const { sync } = await collectorClients(connection);
    const remote = await sync.control({
      id: connection.id,
      expectedRevision: connection.revision,
      action: "pause",
    });
    return { revision: remote.revision, state: remote.state, destinations: collectorDestinations(connection, remote), requestedSyncRevision: remote.requestedSyncRevision, completedSyncRevision: remote.completedSyncRevision };
  },
  async heartbeat(connection, input) {
    const { sync } = await collectorClients(connection);
    const remote = await sync.heartbeat({
      id: connection.id,
      expectedRevision: connection.revision,
      ...input,
    });
    return { revision: remote.revision, state: remote.state, destinations: collectorDestinations(connection, remote), requestedSyncRevision: remote.requestedSyncRevision, completedSyncRevision: remote.completedSyncRevision };
  },
  async admit(connection, entry) {
    const { evidence, sync } = await collectorClients(connection),
      signal = AbortSignal.timeout(60000);
    const bytes = Buffer.from(
      JSON.stringify(
        entry.files.map((file) => ({
          path: file.path,
          encoding: "utf8",
          base64: Buffer.from(file.text).toString("base64"),
        })),
      ),
    );
    const upload = {
      hash: sha256(bytes),
      parts: Math.ceil(bytes.length / 200000),
    };
    for (let index = 0; index < upload.parts; index++)
      await evidence.uploadPart(
        {
          ...upload,
          index,
          base64: bytes
            .subarray(index * 200000, (index + 1) * 200000)
            .toString("base64"),
        },
        signal,
      );
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
    const preview = await evidence.preview(input, signal);
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
