import {
  WorkerImageAttestationContentSchema,
  WorkerImageAttestationSchema,
  type WorkerImageAttestation,
} from "@openpond/contracts";
import { canonicalJson, contentHash } from "@openpond/taskset-sdk";

import type {
  WorkerCatalogSignatureVerifier,
  WorkerCatalogSigner,
} from "./worker-catalog.js";

export type WorkerImageAttestationInput = Omit<
  WorkerImageAttestation,
  "contentHash" | "signature"
>;

export async function signWorkerImageAttestation(input: {
  attestation: Omit<WorkerImageAttestationInput, "signingKeyId">;
  signer: WorkerCatalogSigner;
}): Promise<WorkerImageAttestation> {
  const unhashed = {
    ...input.attestation,
    signingKeyId: input.signer.keyId,
  };
  const content = WorkerImageAttestationContentSchema.parse({
    ...unhashed,
    contentHash: contentHash(unhashed),
  });
  const signature = await input.signer.sign(
    Buffer.from(canonicalJson(content), "utf8"),
  );
  return WorkerImageAttestationSchema.parse({
    ...content,
    signature,
  });
}

export async function verifyWorkerImageAttestation(input: {
  attestation: WorkerImageAttestation;
  verifier: WorkerCatalogSignatureVerifier;
}): Promise<void> {
  const attestation = WorkerImageAttestationSchema.parse(input.attestation);
  const {
    signature,
    contentHash: actualHash,
    ...unhashed
  } = attestation;
  if (contentHash(unhashed) !== actualHash) {
    throw new Error("Worker image attestation content hash mismatch.");
  }
  const content = WorkerImageAttestationContentSchema.parse({
    ...unhashed,
    contentHash: actualHash,
  });
  if (
    !(await input.verifier.verify({
      keyId: attestation.signingKeyId,
      canonicalContent: Buffer.from(canonicalJson(content), "utf8"),
      signature,
    }))
  ) {
    throw new Error("Worker image attestation signature verification failed.");
  }
}
