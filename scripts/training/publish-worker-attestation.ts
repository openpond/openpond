import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  signWorkerImageAttestation,
  type WorkerCatalogSigner,
  type WorkerImageAttestationInput,
} from "@openpond/training-sdk";
import { canonicalJson, sha256 } from "@openpond/taskset-sdk";
import { z } from "zod";

import { GcloudKmsWorkerCatalogSigner } from "./publish-worker-release.js";

const WorkerImagePublicationSchema = z
  .object({
    schemaVersion: z.literal("openpond.workerImagePublication.v1"),
    targetRef: z.string().trim().min(1),
    targetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    imageSizeBytes: z.number().int().positive(),
    contextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceIndexRef: z.string().trim().min(1),
    sourceManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceLayerCount: z.number().int().positive(),
    workerLayerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict();

function option(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>.`);
  return value;
}

function repositoryFromTaggedReference(ref: string): string {
  const lastSlash = ref.lastIndexOf("/");
  const tagSeparator = ref.indexOf(":", lastSlash + 1);
  if (tagSeparator < 1) {
    throw new Error("Worker publication target must contain an image tag.");
  }
  return ref.slice(0, tagSeparator);
}

export async function prepareSignedWorkerImageAttestation(input: {
  publicationPath: string;
  sbomPath: string;
  sbomRef: string;
  signer: WorkerCatalogSigner;
}) {
  const [publicationBytes, sbomBytes] = await Promise.all([
    readFile(input.publicationPath),
    readFile(input.sbomPath),
  ]);
  const publication = WorkerImagePublicationSchema.parse(
    JSON.parse(publicationBytes.toString("utf8")) as unknown,
  );
  if (!/^oci:\/\/.+@sha256:[a-f0-9]{64}$/.test(input.sbomRef)) {
    throw new Error("Worker SBOM must use an immutable OCI reference.");
  }
  const attestation: Omit<
    WorkerImageAttestationInput,
    "signingKeyId"
  > = {
    schemaVersion: "openpond.workerImageAttestation.v1",
    image: {
      repository: repositoryFromTaggedReference(publication.targetRef),
      digest: publication.targetDigest,
      sizeBytes: publication.imageSizeBytes,
      contextSha256: publication.contextSha256,
    },
    source: {
      indexRef: publication.sourceIndexRef,
      manifestDigest: publication.sourceManifestDigest,
      layerCount: publication.sourceLayerCount,
      workerLayerDigest: publication.workerLayerDigest,
    },
    sbom: {
      ref: input.sbomRef,
      sha256: sha256(sbomBytes),
    },
    publishedAt: publication.publishedAt,
  };
  return signWorkerImageAttestation({
    attestation,
    signer: input.signer,
  });
}

async function main(): Promise<void> {
  const outputPath = path.resolve(option("output"));
  const publicKeyPath = path.resolve(option("public-key-output"));
  const signer = new GcloudKmsWorkerCatalogSigner(option("kms-key-version"));
  const attestation = await prepareSignedWorkerImageAttestation({
    publicationPath: path.resolve(option("publication")),
    sbomPath: path.resolve(option("sbom")),
    sbomRef: option("sbom-ref"),
    signer,
  });
  await signer.exportPublicKey(publicKeyPath);
  await writeFile(outputPath, canonicalJson(attestation), {
    mode: 0o644,
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      attestationPath: outputPath,
      publicKeyPath,
      contentHash: attestation.contentHash,
      signingKeyId: attestation.signingKeyId,
      workerImageDigest: attestation.image.digest,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
