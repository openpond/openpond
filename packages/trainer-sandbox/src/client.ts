import type {
  HarnessRelease,
  HarnessRunManifest,
  TrainingArtifacts,
  TrainingExecutionRef,
  TrainingExecutionStatus,
  WorkerEvent,
} from "@openpond/contracts";
import type { ComputeQuote } from "@openpond/training-sdk";

export interface SandboxManagedTrainingClient {
  uploadEnvironmentAsset(input: {
    value: Record<string, unknown>;
    expectedSha256: string;
    idempotencyKey: string;
  }): Promise<{
    objectRef: string;
    sha256: string;
    sizeBytes: number;
    sideEffectsStarted: false;
  }>;
  uploadHarnessRelease(input: {
    release: HarnessRelease;
    assetBundle: {
      objectRef: string;
      sha256: string;
      sizeBytes: number;
    };
    idempotencyKey: string;
  }): Promise<{
    releaseRef: string;
    releaseContentHash: string;
    uploadReceiptHash: string;
  }>;
  materialize(input: {
    manifest: HarnessRunManifest;
    releaseRef: string;
    releaseContentHash: string;
    projection: "environment";
  }): Promise<{
    materializationRef: string;
    materializationHash: string;
    environmentArchiveRef: string;
    environmentArchiveHash: string;
    placementCapabilityReceipt: string;
  }>;
  quote(input: {
    manifest: HarnessRunManifest;
    materializationRef: string;
    materializationHash: string;
  }): Promise<SandboxComputeQuote>;
  approve(input: {
    manifestHash: string;
    materializationRef: string;
    materializationHash: string;
    providerQuote: Record<string, unknown>;
    quoteSignature: string;
    maximumSpendUsd: number;
    approvalHash: string;
  }): Promise<{ approvalLeaseRef: string; expiresAt: string }>;
  launch(input: {
    runId: string;
    manifestHash: string;
    name: string;
    inputBundle: unknown;
    approvalLeaseRef: string;
    idempotencyKey: string;
  }): Promise<TrainingExecutionRef>;
  status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus>;
  events(ref: TrainingExecutionRef, afterSequence: number): Promise<WorkerEvent[]>;
  logs(ref: TrainingExecutionRef, cursor?: string): Promise<{
    cursor: string;
    entries: Array<{ timestamp: string; level: string; message: string }>;
  }>;
  cancel(ref: TrainingExecutionRef): Promise<void>;
  artifacts(ref: TrainingExecutionRef): Promise<TrainingArtifacts>;
}

export type SandboxComputeQuote = ComputeQuote & {
  materializationRef: string;
  materializationHash: string;
  providerQuote: Record<string, unknown>;
  quoteSignature: string;
};
