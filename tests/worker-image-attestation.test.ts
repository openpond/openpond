import { verify as verifySignature } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  verifyWorkerImageAttestation,
} from "@openpond/training-sdk";
import { describe, expect, test } from "vitest";

import {
  prepareSignedWorkerImageAttestation,
} from "../scripts/training/publish-worker-attestation.js";

const signingKeyId =
  "projects/openpond/locations/us-east4/keyRings/releases/cryptoKeys/worker-catalog/cryptoKeyVersions/1";

describe("worker image attestation", () => {
  test("binds an immutable image publication and SBOM under one signature", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-worker-attestation-"),
    );
    try {
      const publicationPath = path.join(directory, "publication.json");
      await writeFile(
        publicationPath,
        JSON.stringify({
          schemaVersion: "openpond.workerImagePublication.v1",
          targetRef:
            "us-east4-docker.pkg.dev/openpond/releases/worker:v0.0.38-test",
          targetDigest: `sha256:${"a".repeat(64)}`,
          imageSizeBytes: 8_000_000_000,
          contextSha256: "b".repeat(64),
          sourceIndexRef:
            "primeintellect/prime-rl@sha256:" + "c".repeat(64),
          sourceManifestDigest: `sha256:${"d".repeat(64)}`,
          sourceLayerCount: 18,
          workerLayerDigest: `sha256:${"e".repeat(64)}`,
          publishedAt: "2026-07-24T15:45:00.000Z",
        }),
      );
      const attestation = await prepareSignedWorkerImageAttestation({
        publicationPath,
        sbomPath: path.resolve(
          "python/openpond-training/worker-sbom.cdx.json",
        ),
        sbomRef:
          "oci://us-east4-docker.pkg.dev/openpond/releases/worker@sha256:" +
          "f".repeat(64),
        signer: {
          keyId: signingKeyId,
          sign: async (content) =>
            Buffer.concat([
              Buffer.from("signed:"),
              Buffer.from(content).subarray(0, 64),
            ]).toString("base64"),
        },
      });

      expect(attestation).toMatchObject({
        signingKeyId,
        image: {
          repository:
            "us-east4-docker.pkg.dev/openpond/releases/worker",
          digest: `sha256:${"a".repeat(64)}`,
        },
        source: {
          workerLayerDigest: `sha256:${"e".repeat(64)}`,
        },
      });
      await expect(
        verifyWorkerImageAttestation({
          attestation,
          verifier: {
            verify: async (input) =>
              input.signature ===
              Buffer.concat([
                Buffer.from("signed:"),
                Buffer.from(input.canonicalContent).subarray(0, 64),
              ]).toString("base64"),
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a mutable SBOM tag", async () => {
    await expect(
      prepareSignedWorkerImageAttestation({
        publicationPath: path.resolve(
          "packages/training-sdk/releases/0.0.38/worker-image-publication.json",
        ),
        sbomPath: path.resolve(
          "python/openpond-training/worker-sbom.cdx.json",
        ),
        sbomRef:
          "oci://us-east4-docker.pkg.dev/openpond/releases/worker:latest",
        signer: {
          keyId: signingKeyId,
          sign: async () => "signature-fixture-012345678901234567890123",
        },
      }),
    ).rejects.toThrow("immutable OCI reference");
  });

  test("verifies the release attestation with the exported KMS public key", async () => {
    const releaseDirectory = path.resolve(
      "packages/training-sdk/releases/0.0.38",
    );
    const [attestation, publicKey] = await Promise.all([
      readFile(
        path.join(releaseDirectory, "worker-image-attestation.json"),
        "utf8",
      ).then((value) => JSON.parse(value)),
      readFile(
        path.join(releaseDirectory, "worker-release-signing-public-key.pem"),
        "utf8",
      ),
    ]);

    await expect(
      verifyWorkerImageAttestation({
        attestation,
        verifier: {
          verify: async (input) =>
            input.keyId === signingKeyId.replace(
              "/keyRings/releases/cryptoKeys/worker-catalog/",
              "/keyRings/openpond-staging/cryptoKeys/model-adapter-manifest-signing/",
            ) &&
            verifySignature(
              "sha256",
              input.canonicalContent,
              publicKey,
              Buffer.from(input.signature, "base64"),
            ),
        },
      }),
    ).resolves.toBeUndefined();
  });
});
