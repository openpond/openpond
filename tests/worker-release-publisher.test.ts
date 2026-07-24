import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyWorkerCatalog } from "@openpond/training-sdk";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import {
  GcloudKmsWorkerCatalogSigner,
  prepareSignedWorkerRelease,
} from "../scripts/training/publish-worker-release.js";

const signingKeyId =
  "projects/openpond/locations/us-east4/keyRings/releases/cryptoKeys/worker-catalog/cryptoKeyVersions/1";

describe("worker release publisher", () => {
  test("validates the tracked SBOM and emits one immutable signed entry", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-worker-conformance-"),
    );
    try {
      const conformanceReceiptPath = await writeConformanceReceipt(directory);
      const catalog = await prepareSignedWorkerRelease({
        openpondRelease: "0.0.38",
        publishedAt: "2026-07-23T12:00:00.000Z",
        imageRepository:
          "us-east4-docker.pkg.dev/openpond/openpond-staging/openpond-worker-prime-rl",
        imageDigest: `sha256:${"a".repeat(64)}`,
        imageSizeBytes: 12_000_000_000,
        sbomPath: path.resolve(
          "python/openpond-training/worker-sbom.cdx.json",
        ),
        sbomRef: "r2://openpond-releases/worker-sbom.cdx.json",
        imageSignatureRef:
          "oci://registry.example.test/worker@sha256:" + "b".repeat(64),
        conformanceReceiptPath,
        conformanceReceiptRef:
          "oci://registry.example.test/worker@sha256:" + "c".repeat(64),
        signer: {
          keyId: signingKeyId,
          sign: async () =>
            Buffer.from("signed catalog fixture").toString("base64"),
        },
      });

      expect(catalog).toMatchObject({
        openpondRelease: "0.0.38",
        workerProtocolVersion: "openpond.connectedWorker.v1",
        signingKeyId,
      });
      expect(catalog.entries).toHaveLength(1);
      expect(catalog.entries[0]).toMatchObject({
        engineAdapterId: "connected-prime-rl",
        image: { digest: `sha256:${"a".repeat(64)}` },
        conformanceReceipt: {
          ref: "oci://registry.example.test/worker@sha256:" +
            "c".repeat(64),
        },
      });
      await expect(
        verifyWorkerCatalog({
          catalog,
          verifier: { verify: async () => true },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an SBOM that does not pin the released upstream graph", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-worker-sbom-"),
    );
    const sbomPath = path.join(directory, "sbom.json");
    try {
      const conformanceReceiptPath = await writeConformanceReceipt(directory);
      await writeFile(
        sbomPath,
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          components: [],
        }),
      );
      await expect(
        prepareSignedWorkerRelease({
          openpondRelease: "0.0.38",
          publishedAt: "2026-07-23T12:00:00.000Z",
          imageRepository: "registry.example.test/worker",
          imageDigest: `sha256:${"a".repeat(64)}`,
          imageSizeBytes: 1,
          sbomPath,
          sbomRef: "r2://releases/sbom.json",
          imageSignatureRef: "kms://releases/attestation",
          conformanceReceiptPath,
          conformanceReceiptRef:
            "oci://registry.example.test/worker@sha256:" + "c".repeat(64),
          signer: {
            keyId: signingKeyId,
            sign: async () => "signed-catalog-fixture-0123456789",
          },
        }),
      ).rejects.toThrow("does not pin prime-rl");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a conformance receipt for another image", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-worker-conformance-"),
    );
    try {
      const conformanceReceiptPath = await writeConformanceReceipt(
        directory,
        `sha256:${"9".repeat(64)}`,
      );
      await expect(
        prepareSignedWorkerRelease({
          openpondRelease: "0.0.38",
          publishedAt: "2026-07-23T12:00:00.000Z",
          imageRepository:
            "us-east4-docker.pkg.dev/openpond/openpond-staging/openpond-worker-prime-rl",
          imageDigest: `sha256:${"a".repeat(64)}`,
          imageSizeBytes: 12_000_000_000,
          sbomPath: path.resolve(
            "python/openpond-training/worker-sbom.cdx.json",
          ),
          sbomRef: "r2://openpond-releases/worker-sbom.cdx.json",
          imageSignatureRef: "kms://releases/attestation",
          conformanceReceiptPath,
          conformanceReceiptRef:
            "oci://registry.example.test/worker@sha256:" + "c".repeat(64),
          signer: {
            keyId: signingKeyId,
            sign: async () => "signed-catalog-fixture-0123456789",
          },
        }),
      ).rejects.toThrow("does not match the release image");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("base64-encodes the binary signature returned by Cloud KMS", async () => {
    const signatureBytes = Buffer.from(
      Array.from({ length: 64 }, (_, index) => index),
    );
    const signer = new GcloudKmsWorkerCatalogSigner(
      signingKeyId,
      async (_file, args) => {
        const signaturePath = args
          .find((argument) => argument.startsWith("--signature-file="))
          ?.slice("--signature-file=".length);
        if (!signaturePath) throw new Error("signature path missing");
        await writeFile(signaturePath, signatureBytes);
        return { stdout: "", stderr: "" };
      },
      async () => "test-adc-access-token",
    );

    await expect(signer.sign(Buffer.from("catalog"))).resolves.toBe(
      signatureBytes.toString("base64"),
    );
  });
});

async function writeConformanceReceipt(
  directory: string,
  imageDigest = `sha256:${"a".repeat(64)}`,
): Promise<string> {
  const pathName = path.join(directory, "worker-conformance.json");
  const unhashed = {
    schemaVersion: "openpond.workerConformanceReceipt.v1" as const,
    status: "passed" as const,
    workerId: "openpond-worker-prime-rl",
    openpondRelease: "0.0.38",
    workerProtocolVersion: "openpond.connectedWorker.v1",
    engineAdapterId: "connected-prime-rl",
    upstreamRevision: "e0d60e4d85ea636873acb2e7083e794740d20226",
    image: {
      repository:
        "us-east4-docker.pkg.dev/openpond/openpond-staging/openpond-worker-prime-rl",
      digest: imageDigest,
    },
    accelerator: "cuda" as const,
    architecture: "sm_90",
    checks: [
      "connected_bootstrap",
      "baseline",
      "rollout",
      "optimizer_update",
      "checkpoint_reload",
      "artifact_return",
      "evaluation",
      "cancellation",
      "zero_resource_cleanup",
    ] as const,
    completedAt: "2026-07-23T12:00:00.000Z",
  };
  await writeFile(
    pathName,
    JSON.stringify({
      ...unhashed,
      contentHash: contentHash(unhashed),
    }),
  );
  return pathName;
}
