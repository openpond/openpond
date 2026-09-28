import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AgentHostStorageClient, HostStorageRequest } from "@openpond/agent-runtime";
import { HostedWorkOutputStorage } from "./hosted-work-output-storage.js";

test("hosted Work output crosses the bounded RPC as verified ordered chunks", async () => {
  const bytes = Buffer.alloc(200_000, 0x5a);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = {
    id: "output-id", title: "result.txt", sourceTaskId: "session-id",
    sourceTurnId: "turn-id", revision: 1, createdAt: "2026-09-28T00:00:00.000Z",
    contentType: "text/plain", sizeBytes: bytes.length, sha256, validation: [],
  } as const;
  const calls: HostStorageRequest[] = [];
  const client = { request: async (request: HostStorageRequest) => {
    calls.push(request);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 256_000);
    if (request.operation === "output/begin") return { uploadId: "upload-id", maxChunkBytes: 98_304 };
    if (request.operation === "output/chunk") return { accepted: true, replayed: false };
    if (request.operation === "output/complete") return { replayed: false, outputRef: {
      kind: "file", ...identity,
      location: { kind: "managed", fileId: "file-id", downloadPath: "/api/work/outputs/file-id" },
    } };
    throw new Error("Unexpected operation");
  } } as unknown as AgentHostStorageClient;
  const result = await new HostedWorkOutputStorage(client).save({
    sessionId: "session-id", turnId: "turn-id", identity: { ...identity, validation: [] }, bytes,
  });
  assert.equal(result.outputRef.location.kind, "managed");
  const chunks = calls.filter((call): call is Extract<HostStorageRequest, { operation: "output/chunk" }> =>
    call.operation === "output/chunk");
  assert.deepEqual(chunks.map((chunk) => [chunk.params.index, chunk.params.offset]),
    [[0, 0], [1, 98_304], [2, 196_608]]);
  assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.params.contentsBase64, "base64"))).compare(bytes), 0);
});
