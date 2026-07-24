import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { HttpConnectedWorkerTransport } from "../packages/trainer-connected/src/index.js";

describe("connected worker HTTP bundle staging", () => {
  test("uploads a local trainer projection in verified chunks", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-worker-stage-"),
    );
    try {
      const bytes = Buffer.from("trainer projection", "utf8");
      await writeFile(path.join(directory, "train.json"), bytes);
      const base = {
        schemaVersion: "openpond.resolvedTrainingBundle.v1" as const,
        projection: "trainer" as const,
        harnessRelease: {
          id: "harness-release",
          contentHash: sha256("harness"),
        },
        datasetRelease: {
          id: "dataset-release",
          contentHash: sha256("dataset"),
        },
        evidenceSetRelease: null,
        files: [
          {
            path: "train.json",
            sha256: sha256(bytes),
            sizeBytes: bytes.byteLength,
          },
        ],
      };
      const manifest = { ...base, contentHash: contentHash(base) };
      await writeFile(
        path.join(directory, "bundle-manifest.json"),
        canonicalJson(manifest),
      );
      const requests: Array<{ path: string; body: Record<string, unknown> }> =
        [];
      const request = async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        requests.push({ path: url.pathname, body });
        if (url.pathname === "/v1/handshake") {
          return response({
            protocolVersion: "openpond.connectedWorker.v1",
            workerId: "worker-1",
            workerRelease: "0.0.38",
            workerImageDigest: `sha256:${"a".repeat(64)}`,
            nonceSignature: "b".repeat(64),
            capabilityReceipt: "c".repeat(64),
            serverTime: "2026-07-24T00:00:00.000Z",
          });
        }
        if (url.pathname === "/v1/bundles/begin") {
          return response({
            uploadId: "upload-1",
            missingPaths: ["train.json"],
          });
        }
        if (url.pathname === "/v1/bundles/chunk") {
          const content = Buffer.from(
            String(body.bytesBase64),
            "base64",
          );
          return response({
            uploadId: "upload-1",
            path: "train.json",
            nextOffset: content.byteLength,
            complete: true,
          });
        }
        if (url.pathname === "/v1/bundles/complete") {
          return response({
            objectRef: "file:///var/lib/openpond-worker/bundle",
            bundleContentHash: manifest.contentHash,
            sha256: manifest.contentHash,
            sizeBytes: bytes.byteLength,
            format: "directory",
          });
        }
        return response({ error: "unexpected" }, 404);
      };
      const transport = new HttpConnectedWorkerTransport(
        new URL("http://127.0.0.1:7443"),
        request,
      );
      await transport.handshake(
        {
          protocolVersion: "openpond.connectedWorker.v1",
          clientRelease: "0.0.38",
          nonce: "nonce-0123456789abcdef",
          expectedWorkerImageDigest: `sha256:${"a".repeat(64)}`,
        },
        "opaque-lease-ref",
      );
      const staged = await transport.stageBundle({
        objectRef: new URL(`file://${directory}/`).toString(),
        bundleContentHash: manifest.contentHash,
        sha256: manifest.contentHash,
        sizeBytes: 0,
        format: "directory",
      }, "lease-1");

      expect(staged.objectRef).toContain("/var/lib/openpond-worker/");
      expect(requests.map((entry) => entry.path)).toEqual([
        "/v1/handshake",
        "/v1/bundles/begin",
        "/v1/bundles/chunk",
        "/v1/bundles/complete",
      ]);
      expect(
        Buffer.from(
          String(requests[2]?.body.bytesBase64),
          "base64",
        ),
      ).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
