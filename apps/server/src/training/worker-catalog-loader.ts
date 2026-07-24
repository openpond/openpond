import { verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SignedWorkerCatalogSchema,
  type SignedWorkerCatalog,
} from "@openpond/contracts";
import { verifyWorkerCatalog } from "@openpond/training-sdk";

const GCP_KMS_KEY_VERSION =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[^/]+$/;

export function createVerifiedWorkerCatalogLoader(input: {
  catalogPath?: string | null;
  publicKeyPath?: string | null;
  expectedOpenpondRelease: string;
  expectedWorkerProtocolVersion: string;
  expectedSigningKeyId?: string | null;
  read?: typeof readFile;
}): () => Promise<SignedWorkerCatalog | null> {
  let cached: Promise<SignedWorkerCatalog | null> | null = null;
  return () => {
    cached ??= load();
    return cached;
  };

  async function load(): Promise<SignedWorkerCatalog | null> {
    const catalogPath = input.catalogPath?.trim() || null;
    const publicKeyPath = input.publicKeyPath?.trim() || null;
    if (!catalogPath && !publicKeyPath) return null;
    if (!catalogPath || !publicKeyPath) {
      throw new Error(
        "Worker catalog and public-key paths must be configured together.",
      );
    }
    const read = input.read ?? readFile;
    const [catalogBytes, publicKey] = await Promise.all([
      read(catalogPath, "utf8"),
      read(publicKeyPath, "utf8"),
    ]);
    const catalog = SignedWorkerCatalogSchema.parse(
      JSON.parse(catalogBytes) as unknown,
    );
    if (!GCP_KMS_KEY_VERSION.test(catalog.signingKeyId)) {
      throw new Error("Worker catalog is not signed by a GCP KMS key version.");
    }
    if (
      input.expectedSigningKeyId &&
      catalog.signingKeyId !== input.expectedSigningKeyId
    ) {
      throw new Error("Worker catalog signing key is not trusted.");
    }
    await verifyWorkerCatalog({
      catalog,
      verifier: {
        async verify(candidate) {
          if (candidate.keyId !== catalog.signingKeyId) return false;
          return verifySignature(
            "sha256",
            candidate.canonicalContent,
            publicKey,
            Buffer.from(candidate.signature, "base64"),
          );
        },
      },
    });
    if (catalog.openpondRelease !== input.expectedOpenpondRelease) {
      throw new Error(
        `Worker catalog targets OpenPond ${catalog.openpondRelease}, not ${input.expectedOpenpondRelease}.`,
      );
    }
    if (
      catalog.workerProtocolVersion !== input.expectedWorkerProtocolVersion
    ) {
      throw new Error("Worker catalog protocol is incompatible.");
    }
    return catalog;
  }
}
