import { sha256, contentHash } from "@openpond/harness";
import { previewAgentImport } from "@openpond/evals/connected-evidence";
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
import { zstdCompressSync } from "node:zlib";
import { refreshRetainedAdmission } from "./retained-admission";
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
  normalized: ReturnType<typeof previewAgentImport>;
} | null = null;

// Each acknowledged part gets a fresh network deadline. The job's cancellation
// signal still bounds the whole import; sharing one minute across every part
// made healthy multi-megabyte uploads expire before preview or commit.
async function admissionStep<T>(
  stage: string,
  cancellation: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(cancellation ? [cancellation] : [])]);
  try {
    return await run(signal);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    throw Object.assign(new Error(`Conversation import ${stage} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
      typeof status === "number" ? { status } : {});
  }
}

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
    const { evidence, sync } = await collectorClients(connection);
    const key = contentHash([connection.id, connection.revision, connection.apiBaseUrl, connection.teamId, connection.account,
      connection.credentialHome, connection.projectId, connection.source.instanceId, entry.branchLeafId, entry.files]);
    if (cachedUpload?.key !== key) {
      const bytes = Buffer.from(JSON.stringify(entry.files.map(file => ({
        path: file.path, encoding: "zstd", base64: zstdCompressSync(Buffer.from(file.text)).toString("base64"),
      }))));
      const normalized = previewAgentImport({ source: connection.source.source, files: entry.files,
        acquisition: { machineId: connection.source.machineId, sourceInstanceId: connection.source.instanceId },
        ...(entry.branchLeafId ? { branchLeafId: entry.branchLeafId } : {}) });
      cachedUpload = { key, bytes, upload: { hash: sha256(bytes), parts: Math.ceil(bytes.length / 200000) }, nextPart: 0, normalized };
    }
    const retained = cachedUpload;
    const admission = refreshRetainedAdmission(connection, entry, retained.normalized);
    const upload = retained.upload;
    while (retained.nextPart < upload.parts) {
      const index = retained.nextPart;
      await admissionStep(`upload part ${index + 1}/${upload.parts}`, cancellation, signal => evidence.uploadPart({ ...upload, index,
        base64: retained.bytes.subarray(index * 200000, (index + 1) * 200000).toString("base64"),
      }, signal));
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
    const preview = retained.preview ??= await admissionStep("preview", cancellation, signal => evidence.preview(input, signal));
    if (preview.issues.length)
      throw Object.assign(
        new Error(
          "Source schema was rejected; inspect the connection before resuming.",
        ),
        { status: 400 },
      );
    const session = preview.sessions.find(
      (item) => item.sessionHash === admission.contentHash,
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
      operationId: admission.operationId,
      previewHash: preview.previewHash,
      selection: [
        { sessionHash: session.sessionHash, boundaryIds: entry.boundaryIds },
      ],
    };
    const result = AgentImportReceiptSchema.parse(
      await admissionStep("commit", cancellation, signal => sync.commit(
        {
          connectionId: connection.id,
          expectedRevision: connection.revision,
          request,
        },
        signal,
      )),
    );
    if (
      result.state !== "completed" ||
      result.operationId !== admission.operationId ||
      result.requestHash !== contentHash(request) ||
      result.projectId !== connection.projectId
    )
      throw new Error("Admission did not acknowledge this retained operation.");
  },
};
