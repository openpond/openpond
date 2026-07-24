import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  GcpKmsWorkerCatalogSigner,
  createPrimeRlWorkerCatalogEntry,
  signWorkerCatalog,
  verifyWorkerCatalog,
} from "@openpond/training-sdk";
import { sha256 } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

describe("signed worker catalog", () => {
  it("binds digest, SBOM, exact upstream revision, compatibility, and conformance", async () => {
    const sbom = await readFile(
      new URL(
        "../python/openpond-training/worker-sbom.cdx.json",
        import.meta.url,
      ),
    );
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const signer = new GcpKmsWorkerCatalogSigner(
      {
        async asymmetricSign(input) {
          return {
            signature: sign(
              "sha256",
              Buffer.from(input.digest.sha256),
              privateKey,
            ),
          };
        },
      },
      "projects/openpond/locations/us-east4/keyRings/releases/cryptoKeys/catalog/cryptoKeyVersions/1",
    );
    const entry = createPrimeRlWorkerCatalogEntry({
      imageRepository:
        "us-east4-docker.pkg.dev/openpond/openpond-staging/openpond-worker-prime-rl",
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageSizeBytes: 12_000_000_000,
      sbomRef:
        "r2://openpond-releases/training/openpond-worker-prime-rl.sbom.cdx.json",
      sbomSha256: createHash("sha256").update(sbom).digest("hex"),
      signatureRef:
        "kms://projects/openpond/locations/us-east4/keyRings/releases/cryptoKeys/catalog/cryptoKeyVersions/1",
      conformanceReceipt: {
        ref: "oci://registry.example.test/worker@sha256:" + "b".repeat(64),
        sha256: sha256("worker-conformance"),
      },
    });
    const catalog = await signWorkerCatalog({
      openpondRelease: "0.0.38",
      workerProtocolVersion: "openpond.connectedWorker.v1",
      entries: [entry],
      publishedAt: "2026-07-23T12:00:00.000Z",
      signer,
    });

    await expect(
      verifyWorkerCatalog({
        catalog,
        verifier: {
          async verify(input) {
            const digest = createHash("sha256")
              .update(input.canonicalContent)
              .digest();
            return verify(
              "sha256",
              digest,
              publicKey,
              Buffer.from(input.signature, "base64"),
            );
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(catalog.entries[0]?.upstreamRevision).toHaveLength(40);
    expect(catalog.entries[0]?.image.sbomSha256).toHaveLength(64);
  });
});
