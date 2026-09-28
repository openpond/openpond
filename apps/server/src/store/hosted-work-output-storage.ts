import { createHash, randomUUID } from "node:crypto";
import { FileOutputRefSchema, WORK_OUTPUT_MAX_BYTES, type FileOutputRef } from "@openpond/contracts";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient,
  type HostedOutputIdentity, type HostedSandboxOutputIdentity } from "@openpond/agent-runtime";
import type { SaveWorkOutputResult } from "../work/work-output-service.js";

const MAX_CHUNK_BYTES = 98_304;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hosted output response is malformed.");
  }
  return value as Record<string, unknown>;
}

/** Transfers a verified output through bounded, replay-safe host requests. */
export class HostedWorkOutputStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async saveSandboxFile(input: {
    sessionId: string;
    turnId: string;
    identity: HostedSandboxOutputIdentity;
    sandboxPath: string;
  }): Promise<SaveWorkOutputResult> {
    if (input.identity.sourceTaskId !== input.sessionId ||
        input.identity.sourceTurnId !== input.turnId) {
      throw new Error("Hosted output source identity mismatch.");
    }
    const completed = asRecord(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
      operation: "output/saveSandboxFile", params: {
        sessionId: input.sessionId, turnId: input.turnId,
        output: input.identity, sandboxPath: input.sandboxPath,
      },
    }, 60_000));
    if (typeof completed.replayed !== "boolean") {
      throw new Error("Hosted sandbox output receipt is malformed.");
    }
    const outputRef = FileOutputRefSchema.parse(completed.outputRef);
    if (outputRef.location.kind !== "managed" || outputRef.id !== input.identity.id ||
        outputRef.title !== input.identity.title || outputRef.revision !== input.identity.revision ||
        outputRef.sourceTaskId !== input.sessionId || outputRef.sourceTurnId !== input.turnId ||
        outputRef.sizeBytes > WORK_OUTPUT_MAX_BYTES) {
      throw new Error("Hosted sandbox output changed immutable identity.");
    }
    return managedResult(outputRef);
  }

  async save(input: {
    sessionId: string;
    turnId: string;
    identity: HostedOutputIdentity;
    bytes: Buffer;
  }): Promise<SaveWorkOutputResult> {
    if (input.bytes.length > WORK_OUTPUT_MAX_BYTES || input.bytes.length !== input.identity.sizeBytes ||
        createHash("sha256").update(input.bytes).digest("hex") !== input.identity.sha256) {
      throw new Error("Hosted output bytes do not match the declared identity.");
    }
    if (input.sessionId !== input.identity.sourceTaskId || input.turnId !== input.identity.sourceTurnId) {
      throw new Error("Hosted output source identity mismatch.");
    }
    const begin = asRecord(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
      operation: "output/begin", params: {
        sessionId: input.sessionId, turnId: input.turnId, output: input.identity,
      },
    }));
    const uploadId = begin.uploadId;
    const maxChunkBytes = begin.maxChunkBytes;
    if (typeof uploadId !== "string" || !uploadId ||
        typeof maxChunkBytes !== "number" || !Number.isInteger(maxChunkBytes) ||
        maxChunkBytes < 1 || maxChunkBytes > MAX_CHUNK_BYTES) {
      throw new Error("Hosted output upload admission is malformed.");
    }
    for (let offset = 0, index = 0; offset < input.bytes.length; offset += maxChunkBytes, index++) {
      const chunk = input.bytes.subarray(offset, Math.min(input.bytes.length, offset + maxChunkBytes));
      const accepted = asRecord(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
        operation: "output/chunk", params: {
          uploadId, index, offset,
          sha256: createHash("sha256").update(chunk).digest("hex"),
          contentsBase64: chunk.toString("base64"),
        },
      }, 60_000));
      if (accepted.accepted !== true || typeof accepted.replayed !== "boolean") {
        throw new Error("Hosted output chunk receipt is malformed.");
      }
    }
    const completed = asRecord(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
      operation: "output/complete", params: { uploadId },
    }, 60_000));
    if (typeof completed.replayed !== "boolean") {
      throw new Error("Hosted output completion receipt is malformed.");
    }
    const outputRef: FileOutputRef = FileOutputRefSchema.parse(completed.outputRef);
    if (outputRef.location.kind !== "managed" || outputRef.id !== input.identity.id ||
        outputRef.sourceTaskId !== input.sessionId || outputRef.sourceTurnId !== input.turnId ||
        outputRef.sha256 !== input.identity.sha256 || outputRef.sizeBytes !== input.identity.sizeBytes ||
        outputRef.revision !== input.identity.revision || outputRef.title !== input.identity.title ||
        outputRef.contentType !== input.identity.contentType) {
      throw new Error("Hosted output completion changed immutable identity.");
    }
    return managedResult(outputRef);
  }
}

function managedResult(outputRef: FileOutputRef): SaveWorkOutputResult {
  if (outputRef.location.kind !== "managed") throw new Error("Managed Work output is required.");
  return { outputRef, artifact: {
    artifactRef: outputRef.location.fileId,
    path: outputRef.location.downloadPath,
    title: outputRef.title,
    contentType: outputRef.contentType,
    sizeBytes: outputRef.sizeBytes,
  } };
}
