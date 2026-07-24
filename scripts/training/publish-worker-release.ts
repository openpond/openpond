import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  WorkerConformanceReceiptSchema,
  type WorkerConformanceReceipt,
} from "@openpond/contracts";
import {
  createPrimeRlWorkerCatalogEntry,
  signWorkerCatalog,
  type WorkerCatalogSigner,
} from "@openpond/training-sdk";
import {
  canonicalJson,
  contentHash,
  sha256,
} from "@openpond/taskset-sdk";

const execFileAsync = promisify(execFile);
const KMS_KEY_VERSION =
  /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)\/cryptoKeyVersions\/([^/]+)$/;

export type WorkerReleaseInput = {
  openpondRelease: string;
  publishedAt: string;
  imageRepository: string;
  imageDigest: string;
  imageSizeBytes: number;
  sbomPath: string;
  sbomRef: string;
  imageSignatureRef: string;
  conformanceReceiptPath: string;
  conformanceReceiptRef: string;
  signer: WorkerCatalogSigner;
};

export async function prepareSignedWorkerRelease(input: WorkerReleaseInput) {
  assertReleaseInput(input);
  const [sbomBytes, conformanceBytes] = await Promise.all([
    readFile(input.sbomPath),
    readFile(input.conformanceReceiptPath),
  ]);
  validateWorkerSbom(JSON.parse(sbomBytes.toString("utf8")) as unknown);
  const conformanceReceipt = validateConformanceReceipt({
    value: JSON.parse(conformanceBytes.toString("utf8")) as unknown,
    openpondRelease: input.openpondRelease,
    imageRepository: input.imageRepository,
    imageDigest: input.imageDigest,
  });
  const entry = createPrimeRlWorkerCatalogEntry({
    imageRepository: input.imageRepository,
    imageDigest: input.imageDigest,
    imageSizeBytes: input.imageSizeBytes,
    sbomRef: input.sbomRef,
    sbomSha256: sha256(sbomBytes),
    signatureRef: input.imageSignatureRef,
    conformanceReceipt: {
      ref: input.conformanceReceiptRef,
      sha256: sha256(conformanceBytes),
    },
  });
  return signWorkerCatalog({
    openpondRelease: input.openpondRelease,
    workerProtocolVersion: "openpond.connectedWorker.v1",
    entries: [entry],
    publishedAt: input.publishedAt,
    signer: input.signer,
  });
}

export class GcloudKmsWorkerCatalogSigner implements WorkerCatalogSigner {
  readonly keyId: string;

  constructor(
    keyVersionName: string,
    private readonly run: typeof execFileAsync = execFileAsync,
    private readonly resolveAccessToken: () => Promise<string> =
      async () => {
        const result = await execFileAsync(
          "gcloud",
          ["auth", "application-default", "print-access-token"],
          { maxBuffer: 1024 * 1024 },
        );
        return result.stdout.trim();
      },
  ) {
    if (!KMS_KEY_VERSION.test(keyVersionName)) {
      throw new Error("A complete GCP KMS crypto-key version name is required.");
    }
    this.keyId = keyVersionName;
  }

  async sign(canonicalContent: Uint8Array): Promise<string> {
    const match = KMS_KEY_VERSION.exec(this.keyId);
    if (!match) throw new Error("GCP KMS key version is invalid.");
    const [, project, location, keyring, key, version] = match;
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-worker-catalog-sign-"),
    );
    const inputPath = path.join(directory, "catalog.json");
    const signaturePath = path.join(directory, "catalog.sig");
    try {
      const accessToken = await this.accessToken();
      await writeFile(inputPath, canonicalContent, { mode: 0o600 });
      await this.run(
        "gcloud",
        [
          "kms",
          "asymmetric-sign",
          `--project=${project}`,
          `--location=${location}`,
          `--keyring=${keyring}`,
          `--key=${key}`,
          `--version=${version}`,
          "--digest-algorithm=sha256",
          `--input-file=${inputPath}`,
          `--signature-file=${signaturePath}`,
          "--quiet",
        ],
        {
          env: {
            ...process.env,
            CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken,
          },
          maxBuffer: 1024 * 1024,
        },
      );
      const signature = (await readFile(signaturePath)).toString("base64");
      if (!/^[A-Za-z0-9+/=]{32,}$/.test(signature)) {
        throw new Error("GCP KMS returned an invalid catalog signature.");
      }
      return signature;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async exportPublicKey(outputPath: string): Promise<void> {
    const match = KMS_KEY_VERSION.exec(this.keyId);
    if (!match) throw new Error("GCP KMS key version is invalid.");
    const [, project, location, keyring, key, version] = match;
    const accessToken = await this.accessToken();
    await this.run(
      "gcloud",
      [
        "kms",
        "keys",
        "versions",
        "get-public-key",
        version!,
        `--project=${project}`,
        `--location=${location}`,
        `--keyring=${keyring}`,
        `--key=${key}`,
        `--output-file=${outputPath}`,
        "--quiet",
      ],
      {
        env: {
          ...process.env,
          CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken,
        },
        maxBuffer: 1024 * 1024,
      },
    );
  }

  private async accessToken(): Promise<string> {
    const value = (await this.resolveAccessToken()).trim();
    if (!value || /\s/.test(value)) {
      throw new Error("GCP ADC returned an invalid access token.");
    }
    return value;
  }
}

function validateConformanceReceipt(input: {
  value: unknown;
  openpondRelease: string;
  imageRepository: string;
  imageDigest: string;
}): WorkerConformanceReceipt {
  const receipt = WorkerConformanceReceiptSchema.parse(input.value);
  const { contentHash: actualHash, ...unhashed } = receipt;
  if (contentHash(unhashed) !== actualHash) {
    throw new Error("Worker conformance receipt content hash mismatch.");
  }
  if (
    receipt.workerId !== "openpond-worker-prime-rl" ||
    receipt.openpondRelease !== input.openpondRelease ||
    receipt.workerProtocolVersion !== "openpond.connectedWorker.v1" ||
    receipt.engineAdapterId !== "connected-prime-rl" ||
    receipt.upstreamRevision !==
      "e0d60e4d85ea636873acb2e7083e794740d20226" ||
    receipt.image.repository !== input.imageRepository ||
    receipt.image.digest !== input.imageDigest
  ) {
    throw new Error(
      "Worker conformance receipt does not match the release image.",
    );
  }
  return receipt;
}

function validateWorkerSbom(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker SBOM must be a CycloneDX JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.bomFormat !== "CycloneDX" ||
    record.specVersion !== "1.6" ||
    !Array.isArray(record.components)
  ) {
    throw new Error("Worker SBOM must use CycloneDX 1.6.");
  }
  const components = new Map(
    record.components.flatMap((component) => {
      if (
        !component ||
        typeof component !== "object" ||
        Array.isArray(component)
      ) {
        return [];
      }
      const item = component as Record<string, unknown>;
      return typeof item.name === "string" && typeof item.version === "string"
        ? [[item.name, item.version] as const]
        : [];
    }),
  );
  const required = {
    "prime-rl": "e0d60e4d85ea636873acb2e7083e794740d20226",
    verifiers: "df9c5aa58c28db717cfeb1150c1d0c751f4570a6",
    torch: "2.9.1",
  };
  for (const [name, version] of Object.entries(required)) {
    if (components.get(name) !== version) {
      throw new Error(`Worker SBOM does not pin ${name} ${version}.`);
    }
  }
}

function assertReleaseInput(input: WorkerReleaseInput): void {
  if (!/^\d+\.\d+\.\d+$/.test(input.openpondRelease)) {
    throw new Error("OpenPond release must be an exact semantic version.");
  }
  if (!Number.isFinite(Date.parse(input.publishedAt))) {
    throw new Error("Worker catalog publication time must be an ISO timestamp.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)) {
    throw new Error("Worker image must be pinned by an immutable digest.");
  }
  if (!Number.isSafeInteger(input.imageSizeBytes) || input.imageSizeBytes <= 0) {
    throw new Error("Worker image size must be a positive integer.");
  }
  if (!input.imageRepository.trim() || !input.sbomRef.trim()) {
    throw new Error("Worker repository and SBOM reference are required.");
  }
  if (!input.imageSignatureRef.trim()) {
    throw new Error("Worker image signature reference is required.");
  }
  if (!input.conformanceReceiptRef.trim()) {
    throw new Error("Worker conformance receipt reference is required.");
  }
}

function option(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((candidate) =>
    candidate.startsWith(prefix)
  )?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>.`);
  return value;
}

async function main(): Promise<void> {
  const outputPath = path.resolve(option("output"));
  const publicKeyPath = path.resolve(option("public-key-output"));
  const signer = new GcloudKmsWorkerCatalogSigner(option("kms-key-version"));
  const catalog = await prepareSignedWorkerRelease({
    openpondRelease: option("openpond-release"),
    publishedAt: option("published-at"),
    imageRepository: option("image-repository"),
    imageDigest: option("image-digest"),
    imageSizeBytes: Number(option("image-size-bytes")),
    sbomPath: path.resolve(option("sbom")),
    sbomRef: option("sbom-ref"),
    imageSignatureRef: option("image-signature-ref"),
    conformanceReceiptPath: path.resolve(option("conformance-receipt")),
    conformanceReceiptRef: option("conformance-receipt-ref"),
    signer,
  });
  await signer.exportPublicKey(publicKeyPath);
  await writeFile(outputPath, canonicalJson(catalog), {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      catalogPath: outputPath,
      publicKeyPath,
      catalogHash: catalog.contentHash,
      signingKeyId: catalog.signingKeyId,
      workerImageDigest: catalog.entries[0]?.image.digest,
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
