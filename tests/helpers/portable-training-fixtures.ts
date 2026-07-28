import {
  HarnessRunManifestContentSchema,
  HarnessRunManifestSchema,
  type HarnessRunManifest,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

export const fixtureTimestamp = "2026-07-23T12:00:00.000Z";

export function createManifestFixture(input?: {
  method?: string;
  recipeConfigHash?: string;
  maximumSpendUsd?: number | null;
  engineAdapterId?: string;
  computeAdapterId?: string;
  computeDeviceOrPool?: string;
  computeKind?: "local" | "ssh" | "managed" | "custom";
  computeProvider?: string | null;
  workerImageDigest?: string | null;
  resolvedBundleHash?: string;
}): HarnessRunManifest {
  const capabilityReceipt = sha256("capability");
  const content = HarnessRunManifestContentSchema.parse({
    schemaVersion: "openpond.harnessRunManifest.v1",
    id: "manifest-1",
    harnessRelease: {
      id: "harness-release-1",
      contentHash: sha256("harness"),
    },
    datasetRelease: {
      id: "dataset-release-1",
      contentHash: sha256("dataset"),
    },
    evidenceSets: [],
    model: {
      source: "huggingface",
      revision: "model-revision",
      artifactHash: null,
      tokenizerRevision: "tokenizer-revision",
      chatTemplateHash: sha256("template"),
    },
    recipe: {
      method: input?.method ?? "grpo",
      version: "1",
      configHash: input?.recipeConfigHash ?? sha256("config"),
    },
    runtimeTarget: {
      adapterId: "runtime-local",
      placement: "local",
      capabilityReceipt,
      runtimeVersion: "1",
      dataPlane: null,
    },
    computeTarget: {
      adapterId: input?.computeAdapterId ?? "compute-local",
      kind: input?.computeKind ?? "local",
      deviceOrPool: input?.computeDeviceOrPool ?? "cpu",
      capabilityReceipt,
      provider: input?.computeProvider ?? null,
    },
    engine: {
      adapterId: input?.engineAdapterId ?? "engine-local",
      workerVersion: "1",
      workerImageDigest: input?.workerImageDigest ?? null,
      upstreamRevision: "fixture",
      capabilityReceipt,
    },
    resolvedBundleHash: input?.resolvedBundleHash ?? sha256("bundle"),
    secretLeaseRefs: [],
    approval: {
      approvalHash: sha256("approval"),
      approvedAt: fixtureTimestamp,
      maximumSpendUsd: input?.maximumSpendUsd ?? 0,
    },
    createdAt: fixtureTimestamp,
  });
  return HarnessRunManifestSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}
