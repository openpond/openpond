import {
  SignedWorkerCatalogContentSchema,
  SignedWorkerCatalogSchema,
  type ComputeTargetCapabilities,
  type SignedWorkerCatalog,
  type TrainingEngineCapabilities,
  type TrainingPreparationPlan,
  type WorkerCatalogEntry,
} from "@openpond/contracts";
import { canonicalJson, contentHash } from "@openpond/taskset-sdk";

export interface WorkerCatalogSigner {
  readonly keyId: string;
  sign(canonicalContent: Uint8Array): Promise<string>;
}

export interface WorkerCatalogSignatureVerifier {
  verify(input: {
    keyId: string;
    canonicalContent: Uint8Array;
    signature: string;
  }): Promise<boolean>;
}

export async function signWorkerCatalog(input: {
  openpondRelease: string;
  workerProtocolVersion: string;
  entries: WorkerCatalogEntry[];
  publishedAt: string;
  signer: WorkerCatalogSigner;
}): Promise<SignedWorkerCatalog> {
  const unhashed = {
    schemaVersion: "openpond.workerCatalog.v1" as const,
    openpondRelease: input.openpondRelease,
    workerProtocolVersion: input.workerProtocolVersion,
    entries: [...input.entries].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    publishedAt: input.publishedAt,
  };
  const content = SignedWorkerCatalogContentSchema.parse({
    ...unhashed,
    contentHash: contentHash(unhashed),
  });
  const signature = await input.signer.sign(
    Buffer.from(canonicalJson(content), "utf8"),
  );
  return SignedWorkerCatalogSchema.parse({
    ...content,
    signature,
    signingKeyId: input.signer.keyId,
  });
}

export async function verifyWorkerCatalog(input: {
  catalog: SignedWorkerCatalog;
  verifier: WorkerCatalogSignatureVerifier;
}): Promise<void> {
  const catalog = SignedWorkerCatalogSchema.parse(input.catalog);
  const {
    signature,
    signingKeyId,
    contentHash: actualHash,
    ...unhashed
  } = catalog;
  if (contentHash(unhashed) !== actualHash) {
    throw new Error("Worker catalog content hash mismatch.");
  }
  const content = SignedWorkerCatalogContentSchema.parse({
    ...unhashed,
    contentHash: actualHash,
  });
  if (
    !(await input.verifier.verify({
      keyId: signingKeyId,
      canonicalContent: Buffer.from(canonicalJson(content), "utf8"),
      signature,
    }))
  ) {
    throw new Error("Worker catalog signature verification failed.");
  }
}

export function prepareTrainingSelection(input: {
  modelRunId: string;
  modelCached: boolean;
  modelBytes: number;
  workerCached: boolean;
  worker: WorkerCatalogEntry | null;
  engine: TrainingEngineCapabilities | null;
  compute: ComputeTargetCapabilities | null;
  manifest: {
    runtime: TrainingPreparationPlan["runtime"];
    compute: TrainingPreparationPlan["compute"];
    engine: TrainingPreparationPlan["engine"];
  };
  maximumSpendUsd: number | null;
  quoteUsd: number | null;
  retentionDays: number | null;
  providerManaged?: boolean;
  workerRequired?: boolean;
}): TrainingPreparationPlan {
  const unsupported =
    input.engine && !input.engine.available
      ? input.engine.unavailableReason ?? "Training engine is unavailable."
      : !input.engine
        ? "Select a compatible training engine."
          : null;
  const state: TrainingPreparationPlan["state"] = unsupported
    ? "unsupported"
    : !input.compute || !input.compute.available
      ? "compute_setup_required"
      : input.providerManaged
        ? "provider_managed"
        : input.workerRequired !== false && input.worker === null
          ? "unsupported"
        : !input.modelCached
          ? "model_download_required"
          : input.workerRequired !== false && !input.workerCached
            ? "worker_download_required"
            : "ready";
  const downloads: TrainingPreparationPlan["downloads"] = [];
  if (!input.modelCached) {
    downloads.push({
      kind: "model",
      label: "Model weights",
      expectedBytes: input.modelBytes,
      digest: input.manifest.engine?.capabilityReceipt ?? "provider-managed",
      cached: false,
      state: "required",
      progress: null,
      cancellable: true,
      diskImpactBytes: input.modelBytes,
    });
  }
  if (input.worker && !input.workerCached) {
    downloads.push({
      kind: "worker",
      label: input.worker.id,
      expectedBytes: input.worker.image.sizeBytes,
      digest: input.worker.image.digest,
      cached: false,
      state: "required",
      progress: null,
      cancellable: true,
      diskImpactBytes: input.worker.image.sizeBytes,
    });
  }
  const base = {
    schemaVersion: "openpond.trainingPreparationPlan.v1" as const,
    modelRunId: input.modelRunId,
    state,
    reason:
      unsupported ??
      (!input.compute || !input.compute.available
        ? input.compute?.unavailableReason ?? "Compute setup is required."
        : input.workerRequired !== false &&
            input.worker === null &&
            !input.providerManaged
          ? "No compatible signed worker image is available."
          : null),
    runtime: input.manifest.runtime,
    compute: input.manifest.compute,
    engine: input.manifest.engine,
    downloads,
    dataMovement: [],
    quoteUsd: input.quoteUsd,
    maximumSpendUsd: input.maximumSpendUsd,
    retentionDays: input.retentionDays,
    sideEffectsStarted: false as const,
  };
  return {
    ...base,
    contentHash: contentHash(base),
  };
}
