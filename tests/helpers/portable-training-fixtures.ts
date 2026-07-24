import type {
  EvidenceSetRelease,
  HarnessRelease,
  HarnessRunManifest,
} from "@openpond/contracts";
import {
  createHarnessRunManifest,
  publishEvidenceSetRelease,
  publishHarnessRelease,
} from "@openpond/training-sdk";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

export const fixtureTimestamp = "2026-07-23T12:00:00.000Z";

const hashes = {
  dataset: sha256("dataset"),
  environment: sha256("environment"),
  grader: sha256("grader"),
  tool: sha256("tool"),
  coverage: sha256("coverage"),
  verification: sha256("verification"),
  capability: sha256("capability"),
  placement: sha256("placement"),
  bundle: sha256("bundle"),
  config: sha256("config"),
  approval: sha256("approval"),
  template: sha256("template"),
};

export function createHarnessFixture(): {
  release: HarnessRelease;
  assets: Map<string, Uint8Array>;
} {
  const student = Buffer.from("export const task = 'student';\n");
  const grader = Buffer.from("export const secretScore = 1;\n");
  const assets = new Map<string, Uint8Array>([
    ["student.ts", student],
    ["grader.ts", grader],
  ]);
  const child = (
    kind:
      | "program"
      | "tool_contract"
      | "runtime_spec"
      | "grader_definition"
      | "feedback_policy"
      | "dependency_lock"
      | "extension_lock",
  ) => ({
    kind,
    id: `${kind}-v1`,
    contentHash: sha256(kind),
    contractVersion: "1",
  });
  return {
    assets,
    release: publishHarnessRelease({
      schemaVersion: "openpond.harnessRelease.v1",
      id: "harness-release-1",
      revision: 1,
      profileRelease: null,
      children: [
        child("program"),
        child("tool_contract"),
        child("runtime_spec"),
        child("grader_definition"),
        child("feedback_policy"),
        child("dependency_lock"),
        child("extension_lock"),
      ],
      assets: [
        {
          path: "student.ts",
          sha256: sha256(student),
          sizeBytes: student.byteLength,
          mediaType: "text/typescript",
          executable: false,
          projections: ["student", "orchestrator"],
          visibility: "model_visible",
        },
        {
          path: "grader.ts",
          sha256: sha256(grader),
          sizeBytes: grader.byteLength,
          mediaType: "text/typescript",
          executable: false,
          projections: ["privileged_scorer"],
          visibility: "privileged",
        },
      ],
      secretDeclarations: [
        {
          id: "grader-token",
          purpose: "Authenticate the privileged grader.",
          audience: "privileged_scorer",
          required: true,
          ttlSeconds: 300,
          scopes: ["grade"],
        },
      ],
      requiredContracts: {
        openpondRelease: "0.0.38",
        workerProtocol: "1",
        harnessRuntime: "1",
        trace: "1",
      },
      sourceRevision: "fixture",
      publishedAt: fixtureTimestamp,
      metadata: {},
    }),
  };
}

export function createEvidenceFixture(
  harness: HarnessRelease,
): EvidenceSetRelease {
  return publishEvidenceSetRelease({
    schemaVersion: "openpond.evidenceSetRelease.v1",
    id: "evidence-set-1",
    revision: 1,
    datasetRelease: { id: "dataset-release-1", contentHash: hashes.dataset },
    harnessRelease: { id: harness.id, contentHash: harness.contentHash },
    profileRelease: null,
    model: {
      source: "huggingface",
      revision: "model-revision",
      artifactHash: null,
    },
    environmentHash: hashes.environment,
    toolContractHash: hashes.tool,
    graderHash: hashes.grader,
    signals: [
      {
        id: "demonstration-1",
        kind: "demonstration",
        contentHash: sha256("demonstration-1"),
        objectRef: "r2://evidence/demonstration-1.json",
        approved: true,
        verificationReceiptHash: hashes.verification,
      },
    ],
    coverageReceiptHash: hashes.coverage,
    verificationPolicyHash: hashes.verification,
    publishedAt: fixtureTimestamp,
  });
}

export function createManifestFixture(input?: {
  harness?: HarnessRelease;
  evidence?: EvidenceSetRelease[];
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
  const harness = input?.harness ?? createHarnessFixture().release;
  const evidence = input?.evidence ?? [];
  const manifest = createHarnessRunManifest({
    schemaVersion: "openpond.harnessRunManifest.v1",
    id: "manifest-1",
    harnessRelease: { id: harness.id, contentHash: harness.contentHash },
    datasetRelease: { id: "dataset-release-1", contentHash: hashes.dataset },
    evidenceSets: evidence.map((release) => ({
      id: release.id,
      contentHash: release.contentHash,
    })),
    model: {
      source: "huggingface",
      revision: "model-revision",
      artifactHash: null,
      tokenizerRevision: "tokenizer-revision",
      chatTemplateHash: hashes.template,
    },
    recipe: {
      method: input?.method ?? "grpo",
      version: "1",
      configHash: input?.recipeConfigHash ?? hashes.config,
    },
    runtimeTarget: {
      adapterId: "runtime-local",
      placement: "local",
      capabilityReceipt: hashes.capability,
      runtimeVersion: "1",
      dataPlane: {
        provider: "latitude",
        dataPlaneId: "openpond-latitude-staging",
        cellId: "openpond-latitude-staging-k8s",
        runnerPoolId: "sandbox-pool-v1",
        runtimeImageDigest: `sha256:${sha256("runtime-image")}`,
        capabilityReceipt: hashes.placement,
      },
    },
    computeTarget: {
      adapterId: input?.computeAdapterId ?? "compute-local",
      kind: input?.computeKind ?? "local",
      deviceOrPool: input?.computeDeviceOrPool ?? "cpu",
      capabilityReceipt: hashes.capability,
      provider: input?.computeProvider ?? null,
    },
    engine: {
      adapterId: input?.engineAdapterId ?? "engine-local",
      workerVersion: "1",
      workerImageDigest: input?.workerImageDigest ?? null,
      upstreamRevision: "fixture",
      capabilityReceipt: hashes.capability,
    },
    resolvedBundleHash: input?.resolvedBundleHash ?? hashes.bundle,
    secretLeaseRefs: harness.secretDeclarations
      .filter((declaration) => declaration.required)
      .map((declaration) => ({
        declarationId: declaration.id,
        leaseRef: `opaque-lease-${declaration.id}`,
        audience: declaration.audience,
        expiresAt: "2026-07-23T12:10:00.000Z",
      })),
    approval: {
      approvalHash: hashes.approval,
      approvedAt: fixtureTimestamp,
      maximumSpendUsd: input?.maximumSpendUsd ?? 0,
    },
    createdAt: fixtureTimestamp,
  });
  const expectedHash = contentHash(
    Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "contentHash"),
    ),
  );
  if (manifest.contentHash !== expectedHash) {
    throw new Error("Fixture manifest is not canonical.");
  }
  return manifest;
}
