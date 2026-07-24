import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AdapterValidationReceiptSchema,
  TrainingArtifactsSchema,
  TrainingEngineCapabilitiesSchema,
  TrainingExecutionRefSchema,
  TrainingExecutionStatusSchema,
  WorkerArtifactChunkSchema,
  WorkerEventSchema,
  WorkerHandshakeResponseSchema,
  WorkerBundleUploadChunkReceiptSchema,
  WorkerBundleUploadSessionSchema,
  WorkerLeaseSchema,
  WorkerLogPageSchema,
  WorkerResolvedBundleSchema,
  ResolvedTrainingBundleManifestSchema,
} from "@openpond/contracts";
import { Agent, fetch as undiciFetch } from "undici";

import type { ConnectedWorkerTransport } from "./protocol-client.js";

type WorkerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createMtlsWorkerFetch(input: {
  clientCertificate: string;
  clientPrivateKey: string;
  serverCertificateAuthority: string;
  serverName?: string;
}): WorkerFetch {
  for (const [label, value] of [
    ["client certificate", input.clientCertificate],
    ["client private key", input.clientPrivateKey],
    ["server certificate authority", input.serverCertificateAuthority],
  ] as const) {
    if (!value.trim()) {
      throw new Error(`Connected worker ${label} is empty.`);
    }
  }
  const dispatcher = new Agent({
    connect: {
      cert: input.clientCertificate,
      key: input.clientPrivateKey,
      ca: input.serverCertificateAuthority,
      rejectUnauthorized: true,
      ...(input.serverName
        ? { servername: validateServerName(input.serverName) }
        : {}),
    },
  });
  return async (request, init) =>
    (await undiciFetch(
      request as Parameters<typeof undiciFetch>[0],
      {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      },
    )) as unknown as Response;
}

function validateServerName(value: string): string {
  const serverName = value.trim();
  if (
    !serverName ||
    serverName.length > 253 ||
    !/^[A-Za-z0-9.-]+$/.test(serverName)
  ) {
    throw new Error("Connected worker TLS server name is invalid.");
  }
  return serverName;
}

export class HttpConnectedWorkerTransport
  implements ConnectedWorkerTransport
{
  private secretLeaseRef: string | null = null;

  constructor(
    private readonly endpoint: URL,
    private readonly request: WorkerFetch = fetch,
  ) {
    if (endpoint.protocol !== "https:" && !isLoopback(endpoint.hostname)) {
      throw new Error("Connected worker transport requires HTTPS outside loopback.");
    }
  }

  async handshake(request: Parameters<ConnectedWorkerTransport["handshake"]>[0], secretLeaseRef: string) {
    this.secretLeaseRef = secretLeaseRef;
    return WorkerHandshakeResponseSchema.parse(
      await this.post("/v1/handshake", request),
    );
  }

  async acquireLease(input: { runId: string; durationSeconds: number }) {
    return WorkerLeaseSchema.parse(await this.post("/v1/leases", input));
  }

  async heartbeat(leaseId: string) {
    return WorkerLeaseSchema.parse(
      await this.post(`/v1/leases/${encodeURIComponent(leaseId)}/heartbeat`, {}),
    );
  }

  async capabilities() {
    return TrainingEngineCapabilitiesSchema.parse(
      await this.get("/v1/capabilities"),
    );
  }

  async stageBundle(
    bundle: Parameters<ConnectedWorkerTransport["stageBundle"]>[0],
    leaseId: Parameters<ConnectedWorkerTransport["stageBundle"]>[1],
  ) {
    const descriptor = WorkerResolvedBundleSchema.parse(bundle);
    if (
      descriptor.format === "tar" &&
      descriptor.objectRef.startsWith("https://")
    ) {
      return descriptor;
    }
    if (
      descriptor.format !== "directory" ||
      !descriptor.objectRef.startsWith("file://")
    ) {
      throw new Error(
        "Connected worker bundle staging requires a local directory or an HTTPS tar archive.",
      );
    }
    const directory = path.resolve(
      fileURLToPath(descriptor.objectRef),
    );
    const manifest = ResolvedTrainingBundleManifestSchema.parse(
      JSON.parse(
        await readFile(
          new URL("bundle-manifest.json", ensureDirectoryUrl(descriptor.objectRef)),
          "utf8",
        ),
      ),
    );
    if (manifest.contentHash !== descriptor.bundleContentHash) {
      throw new Error(
        "Connected worker bundle descriptor does not match its manifest.",
      );
    }
    const session = WorkerBundleUploadSessionSchema.parse(
      await this.post("/v1/bundles/begin", { leaseId, manifest }),
    );
    const missing = new Set(session.missingPaths);
    for (const file of manifest.files) {
      if (!missing.has(file.path)) continue;
      const filePath = new URL(
        file.path,
        ensureDirectoryUrl(descriptor.objectRef),
      );
      const localPath = path.resolve(fileURLToPath(filePath));
      if (
        path.relative(directory, localPath)
          .split(path.sep)
          .join("/") !== file.path
      ) {
        throw new Error("Connected worker bundle asset path is invalid.");
      }
      const metadata = await lstat(localPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          `Connected worker bundle asset ${file.path} is not a regular file.`,
        );
      }
      const bytes = await readFile(localPath);
      if (
        bytes.byteLength !== file.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      ) {
        throw new Error(
          `Connected worker bundle asset ${file.path} changed before upload.`,
        );
      }
      const chunkSize = 1024 * 1024;
      for (
        let offset = 0;
        offset < Math.max(1, bytes.byteLength);
        offset += chunkSize
      ) {
        const chunk = bytes.subarray(
          offset,
          Math.min(bytes.byteLength, offset + chunkSize),
        );
        const final = offset + chunk.byteLength >= bytes.byteLength;
        const receipt = WorkerBundleUploadChunkReceiptSchema.parse(
          await this.post("/v1/bundles/chunk", {
            uploadId: session.uploadId,
            leaseId,
            path: file.path,
            offset,
            bytesBase64: chunk.toString("base64"),
            chunkHash: createHash("sha256")
              .update(chunk)
              .digest("hex"),
            final,
          }),
        );
        if (
          receipt.nextOffset !== offset + chunk.byteLength ||
          receipt.complete !== final
        ) {
          throw new Error(
            "Connected worker bundle upload receipt is inconsistent.",
          );
        }
      }
    }
    return WorkerResolvedBundleSchema.parse(
      await this.post("/v1/bundles/complete", {
        uploadId: session.uploadId,
        leaseId,
      }),
    );
  }

  async validate(plan: Parameters<ConnectedWorkerTransport["validate"]>[0]) {
    return AdapterValidationReceiptSchema.parse(
      await this.post("/v1/validate", plan),
    );
  }

  async launch(input: Parameters<ConnectedWorkerTransport["launch"]>[0]) {
    return TrainingExecutionRefSchema.parse(
      await this.post("/v1/launch", input),
    );
  }

  async sendSignals(
    ref: Parameters<ConnectedWorkerTransport["sendSignals"]>[0],
    batch: Parameters<ConnectedWorkerTransport["sendSignals"]>[1],
  ) {
    await this.post("/v1/signals", { ref, batch });
  }

  async status(ref: Parameters<ConnectedWorkerTransport["status"]>[0]) {
    return TrainingExecutionStatusSchema.parse(
      await this.post("/v1/status", { ref }),
    );
  }

  async events(
    ref: Parameters<ConnectedWorkerTransport["events"]>[0],
    afterSequence: number,
  ) {
    const response = await this.post("/v1/events", { ref, afterSequence });
    const events =
      response && typeof response === "object" && "events" in response
        ? (response as { events: unknown }).events
        : response;
    return WorkerEventSchema.array().parse(events);
  }

  async logs(
    ref: Parameters<ConnectedWorkerTransport["logs"]>[0],
    cursor?: string,
  ) {
    return WorkerLogPageSchema.parse(
      await this.post("/v1/logs", { ref, cursor: cursor ?? null }),
    );
  }

  async cancel(ref: Parameters<ConnectedWorkerTransport["cancel"]>[0]) {
    await this.post("/v1/cancel", { ref });
  }

  async artifacts(
    ref: Parameters<ConnectedWorkerTransport["artifacts"]>[0],
  ) {
    return TrainingArtifactsSchema.parse(
      await this.post("/v1/artifacts", { ref }),
    );
  }

  async downloadArtifact(
    input: Parameters<ConnectedWorkerTransport["downloadArtifact"]>[0],
  ) {
    return WorkerArtifactChunkSchema.parse(
      await this.post("/v1/artifacts/chunk", input),
    );
  }

  async releaseLease(leaseId: string) {
    await this.post(
      `/v1/leases/${encodeURIComponent(leaseId)}/release`,
      {},
    );
  }

  private get(path: string): Promise<unknown> {
    return this.send(path, { method: "GET" });
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.send(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async send(path: string, init: RequestInit): Promise<unknown> {
    if (path !== "/v1/handshake" && !this.secretLeaseRef) {
      throw new Error("Connected worker handshake is required.");
    }
    const response = await this.request(new URL(path, this.endpoint), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.secretLeaseRef
          ? { "x-openpond-secret-lease-ref": this.secretLeaseRef }
          : {}),
      },
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
      throw new Error(`Connected worker request failed: ${message}`);
    }
    return payload;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function ensureDirectoryUrl(value: string): URL {
  return new URL(value.endsWith("/") ? value : `${value}/`);
}
