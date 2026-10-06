import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  HostStorageRequestSchema,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { FileOutputRefSchema, type FileOutputRef } from "@openpond/contracts";
import { sha256 } from "@openpond/harness";
import type { createWorkOutputService } from "../work/work-output-service.js";

const CHUNK_BYTES = 98_304;

/** Host-managed outputs survive the policy sandbox and child runtime cache.
 * Tenant, exact case and active lease admission are enforced by the host. */
export function createHostedProfileArtifactOwner(client: AgentHostStorageClient): {
  persistence: NonNullable<Parameters<typeof createWorkOutputService>[0]["managedPersistence"]>;
  read(output: FileOutputRef, signal?: AbortSignal): Promise<Buffer>;
} {
  const request = (
    operation: "output/begin" | "output/chunk" | "output/complete" | "output/readBytes",
    params: Record<string, unknown>,
  ) =>
    client.request(
      HostStorageRequestSchema.parse({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(),
        operation,
        params,
      }),
    );
  return {
    persistence: {
      sourceTurnStartedAt: async () => {
        throw new Error("The case owner must supply its actual turn start time.");
      },
      saveSandboxFile: async () => {
        throw new Error("Isolated Profile outputs must be read by the confined case owner.");
      },
      save: async ({ sessionId, turnId, identity, bytes }) => {
        const admitted = z
          .object({
            uploadId: z.string().min(1),
            maxChunkBytes: z.literal(CHUNK_BYTES),
          })
          .parse(
            await request("output/begin", {
              sessionId,
              turnId,
              output: identity,
            }),
          );
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
          await request("output/chunk", {
            uploadId: admitted.uploadId,
            index: offset / CHUNK_BYTES,
            offset,
            sha256: sha256(chunk),
            contentsBase64: chunk.toString("base64"),
          });
        }
        const { outputRef } = z
          .object({ outputRef: FileOutputRefSchema })
          .parse(await request("output/complete", { uploadId: admitted.uploadId }));
        if (
          outputRef.location.kind !== "managed" ||
          outputRef.sha256 !== identity.sha256 ||
          outputRef.sizeBytes !== bytes.length ||
          outputRef.sourceTaskId !== sessionId ||
          outputRef.sourceTurnId !== turnId ||
          outputRef.id !== identity.id ||
          outputRef.revision !== identity.revision
        )
          throw new Error("The durable case output differs from its saved identity.");
        return {
          outputRef,
          artifact: {
            artifactRef: outputRef.location.fileId,
            path: outputRef.location.downloadPath,
            title: outputRef.title,
            contentType: outputRef.contentType,
            sizeBytes: outputRef.sizeBytes,
          },
        };
      },
    },
    read: async (output, signal) => {
      if (output.location.kind !== "managed" || output.sizeBytes > 10_000_000)
        throw new Error("Select a bounded managed case output.");
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < output.sizeBytes; offset += CHUNK_BYTES) {
        signal?.throwIfAborted();
        const result = z
          .object({
            offset: z.number().int(),
            contentsBase64: z.string().max(131_072),
            sha256: z.string(),
            sizeBytes: z.number().int(),
          })
          .parse(
            await request("output/readBytes", {
              sessionId: output.sourceTaskId,
              turnId: output.sourceTurnId,
              fileId: output.location.fileId,
              revision: output.revision,
              sha256: output.sha256,
              sizeBytes: output.sizeBytes,
              offset,
            }),
          );
        const bytes = Buffer.from(result.contentsBase64, "base64");
        if (
          result.offset !== offset ||
          result.sha256 !== output.sha256 ||
          result.sizeBytes !== output.sizeBytes ||
          bytes.length !== Math.min(CHUNK_BYTES, output.sizeBytes - offset) ||
          bytes.toString("base64") !== result.contentsBase64
        )
          throw new Error("The durable workbook byte range changed.");
        chunks.push(bytes);
      }
      signal?.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      if (sha256(bytes) !== output.sha256)
        throw new Error("The durable workbook differs from its sealed hash.");
      return bytes;
    },
  };
}
