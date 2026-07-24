import { createHash } from "node:crypto";

import type {
  WorkerEvidenceReference,
  WorkerCatalogEntry,
} from "@openpond/contracts";

import type { WorkerCatalogSigner } from "./worker-catalog.js";

export interface GcpKmsAsymmetricSignClient {
  asymmetricSign(input: {
    name: string;
    digest: { sha256: Uint8Array };
  }): Promise<{ signature: Uint8Array | string | null | undefined }>;
}

export class GcpKmsWorkerCatalogSigner implements WorkerCatalogSigner {
  readonly keyId: string;

  constructor(
    private readonly client: GcpKmsAsymmetricSignClient,
    private readonly keyVersionName: string,
  ) {
    this.keyId = keyVersionName;
  }

  async sign(canonicalContent: Uint8Array): Promise<string> {
    const digest = createHash("sha256").update(canonicalContent).digest();
    const result = await this.client.asymmetricSign({
      name: this.keyVersionName,
      digest: { sha256: digest },
    });
    if (!result.signature) {
      throw new Error("GCP KMS returned no worker catalog signature.");
    }
    return Buffer.from(result.signature).toString("base64");
  }
}

export function createPrimeRlWorkerCatalogEntry(input: {
  imageRepository: string;
  imageDigest: string;
  imageSizeBytes: number;
  sbomRef: string;
  sbomSha256: string;
  signatureRef: string;
  conformanceReceipt: WorkerEvidenceReference;
}): WorkerCatalogEntry {
  return {
    id: "openpond-worker-prime-rl",
    engineAdapterId: "connected-prime-rl",
    workerProtocolVersion: "openpond.connectedWorker.v1",
    openpondReleaseRange: ">=0.0.38 <0.1.0",
    upstreamRevision: "e0d60e4d85ea636873acb2e7083e794740d20226",
    image: {
      repository: input.imageRepository,
      digest: input.imageDigest,
      sizeBytes: input.imageSizeBytes,
      sbomRef: input.sbomRef,
      sbomSha256: input.sbomSha256,
      signatureRef: input.signatureRef,
    },
    runtime: {
      python: "3.12",
      torch: "2.9",
      accelerator: "cuda",
      acceleratorVersion: "12.8.1",
      architectures: ["sm_90"],
    },
    methods: ["grpo"],
    modelFamilies: ["transformers"],
    precisions: ["fp16", "bf16", "tf32"],
    conformanceReceipt: input.conformanceReceipt,
  };
}
