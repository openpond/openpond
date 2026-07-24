import { generateKeyPairSync, sign } from "node:crypto";

import { createPrimeRlWorkerCatalogEntry, signWorkerCatalog } from "@openpond/training-sdk";
import { sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { createVerifiedWorkerCatalogLoader } from "../apps/server/src/training/worker-catalog-loader.js";

describe("server worker catalog loader", () => {
  test("accepts only a signed release-compatible GCP KMS catalog", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const keyId =
      "projects/openpond/locations/us-east4/keyRings/releases/cryptoKeys/catalog/cryptoKeyVersions/1";
    const catalog = await signWorkerCatalog({
      openpondRelease: "0.0.38",
      workerProtocolVersion: "openpond.connectedWorker.v1",
      entries: [entry()],
      publishedAt: "2026-07-23T12:00:00.000Z",
      signer: {
        keyId,
        async sign(canonicalContent) {
          return sign("sha256", canonicalContent, privateKey).toString("base64");
        },
      },
    });
    const files = new Map<string, string>([
      ["/catalog.json", JSON.stringify(catalog)],
      [
        "/catalog.pem",
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ],
    ]);
    const load = createVerifiedWorkerCatalogLoader({
      catalogPath: "/catalog.json",
      publicKeyPath: "/catalog.pem",
      expectedOpenpondRelease: "0.0.38",
      expectedWorkerProtocolVersion: "openpond.connectedWorker.v1",
      expectedSigningKeyId: keyId,
      read: async (file) => {
        const value = files.get(String(file));
        if (!value) throw new Error("missing fixture");
        return value;
      },
    });

    await expect(load()).resolves.toEqual(catalog);
  });

  test("fails closed on catalog tampering", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const catalog = await signWorkerCatalog({
      openpondRelease: "0.0.38",
      workerProtocolVersion: "openpond.connectedWorker.v1",
      entries: [entry()],
      publishedAt: "2026-07-23T12:00:00.000Z",
      signer: {
        keyId:
          "projects/openpond/locations/global/keyRings/releases/cryptoKeys/catalog/cryptoKeyVersions/1",
        async sign(canonicalContent) {
          return sign("sha256", canonicalContent, privateKey).toString("base64");
        },
      },
    });
    const load = createVerifiedWorkerCatalogLoader({
      catalogPath: "/catalog.json",
      publicKeyPath: "/catalog.pem",
      expectedOpenpondRelease: "0.0.38",
      expectedWorkerProtocolVersion: "openpond.connectedWorker.v1",
      read: async (file) =>
        String(file).endsWith(".pem")
          ? publicKey.export({ type: "spki", format: "pem" }).toString()
          : JSON.stringify({
              ...catalog,
              entries: [
                {
                  ...catalog.entries[0],
                  image: {
                    ...catalog.entries[0]!.image,
                    digest: `sha256:${"b".repeat(64)}`,
                  },
                },
              ],
            }),
    });

    await expect(load()).rejects.toThrow(/hash mismatch|verification failed/);
  });
});

function entry() {
  return createPrimeRlWorkerCatalogEntry({
    imageRepository:
      "us-east4-docker.pkg.dev/openpond/releases/openpond-worker-prime-rl",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageSizeBytes: 12_000_000_000,
    sbomRef: "r2://openpond-releases/worker.sbom.cdx.json",
    sbomSha256: sha256("sbom"),
    signatureRef: "kms://projects/openpond/releases/worker",
    conformanceReceipt: {
      ref: "oci://registry.example.test/worker@sha256:" + "b".repeat(64),
      sha256: sha256("conformance"),
    },
  });
}
