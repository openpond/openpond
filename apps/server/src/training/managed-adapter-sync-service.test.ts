import type { ModelArtifactLineage, TrainingArtifact } from "@openpond/contracts";
import { describe, expect, test, vi } from "vitest";
import type { SqliteStore } from "../store/store.js";
import type { ManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import { createManagedAdapterSyncService } from "./managed-adapter-sync-service.js";

const BASE_PROFILE_ID = "qwen3-8b-b968826d";
const BASE_REVISION = "b968826d9c46dd6066d109eabc6255188de91218";
const CHAT_TEMPLATE_HASH = "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8";
const timestamp = "2026-07-19T16:00:00.000Z";

function lineage(): ModelArtifactLineage {
  return {
    schemaVersion: "openpond.modelArtifactLineage.v1",
    id: "lineage-qa",
    modelId: "model-qa",
    artifactId: "source-adapter",
    jobId: "job-qa",
    tasksetId: "taskset-qa",
    tasksetHash: "a".repeat(64),
    graderHash: "b".repeat(64),
    planHash: "c".repeat(64),
    bundleHash: "d".repeat(64),
    recipeHash: "e".repeat(64),
    workerVersion: "worker-v1",
    trainerVersion: "trainer-v1",
    importedAt: timestamp,
    frozenEvaluationArtifactId: null,
    promotable: true,
    pinned: false,
    status: "imported",
    rejectedAt: null,
    rejectionReason: null,
    chatConfiguration: {
      schemaVersion: "openpond.localModelChatConfiguration.v1",
      profile: "efficient",
      systemPromptMode: "lean",
      customSystemPrompt: null,
      contextWindowTokens: 1024,
      maxOutputTokens: 64,
      temperature: 0,
      repetitionPenalty: 1.1,
      noRepeatNgramSize: 3,
      compaction: "when_needed",
      keepWarmSeconds: 300,
      updatedAt: null,
    },
    managedServing: null,
  };
}

function capabilities() {
  return {
    schemaVersion: "openpond.modelAdapterPlatformCapabilities.v1" as const,
    baseModelProfileContractVersion: "openpond.baseModelProfile.v2" as const,
    lifecyclePolicyOwner: "sandbox" as const,
    baseProfiles: [
      {
        id: BASE_PROFILE_ID,
        repository: "Qwen/Qwen3-8B",
        revision: BASE_REVISION,
        tokenizerRevision: BASE_REVISION,
        chatTemplateHash: CHAT_TEMPLATE_HASH,
        status: "supported" as const,
      },
    ],
  };
}

describe("managed adapter sync service", () => {
  test("waits for Sandbox canonical publication without uploading managed bytes", async () => {
    const harness = createManagedHarness(null, null);

    await harness.service.reconcile();

    expect(harness.saved()?.managedServing).toMatchObject({
      teamId: "team_managed",
      source: "sandbox_managed_rl",
      sourceRef: "managed-job-qa",
      state: "failed",
      lastError: expect.stringContaining("canonical publication"),
    });
  });

  test("observes the Sandbox-owned candidate and ready deployment", async () => {
    const harness = createManagedHarness(
      {
        id: "canonical-artifact",
        source: "sandbox_managed_rl",
        sourceRef: "r2://managed-rl/tenants/team_managed/jobs/managed-job-qa/candidate.json",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
        contentHash: "1".repeat(64),
        baseProfileId: BASE_PROFILE_ID,
      },
      { id: "deployment-managed", artifactId: "canonical-artifact", state: "ready" },
    );

    await harness.service.reconcile();

    expect(harness.saved()?.managedServing).toMatchObject({
      source: "sandbox_managed_rl",
      canonicalArtifactId: "canonical-artifact",
      canonicalDeploymentId: "deployment-managed",
      state: "ready",
      customerBindingAllowed: true,
      baseProfileId: BASE_PROFILE_ID,
      lastError: null,
    });
  });
});

function createManagedHarness(
  registryArtifact: Parameters<typeof createHarness>[0]["registryArtifact"],
  deployment: Parameters<typeof createHarness>[0]["deployment"],
) {
  const candidate: TrainingArtifact = {
    schemaVersion: "openpond.trainingArtifact.v1",
    id: "source-adapter",
    jobId: "job-qa",
    kind: "adapter",
    path: "sandbox-managed-rl://managed-job-qa/model-artifact-qa",
    sha256: "4".repeat(64),
    sizeBytes: 8_000_000,
    baseModelId: "Qwen/Qwen3-8B",
    baseModelRevision: BASE_REVISION,
    tokenizerRevision: BASE_REVISION,
    chatTemplateHash: CHAT_TEMPLATE_HASH,
    nonProduction: false,
    createdAt: timestamp,
    metadata: {
      provider: "sandbox",
      providerFilename: "managed-rl-candidate",
      managedRlCandidate: true,
      managedRlJobId: "managed-job-qa",
      managedRlModelArtifactId: "model-artifact-qa",
      managedRlTeamId: "team_managed",
    },
  };
  return createHarness({ currentLineage: lineage(), artifacts: [candidate], registryArtifact, deployment });
}

function createHarness(input: {
  currentLineage: ModelArtifactLineage;
  artifacts: TrainingArtifact[];
  registryArtifact: {
    id: string;
    source: string;
    sourceRef: string;
    state: string;
    promotable: boolean;
    customerBindingAllowed: boolean;
    contentHash?: string;
    baseProfileId?: string;
  } | null;
  deployment: { id: string; artifactId: string; state: string } | null;
}) {
  let saved: ModelArtifactLineage | null = null;
  const store = {
    listModelArtifactLineage: vi.fn(async () => [input.currentLineage]),
    listTrainingArtifacts: vi.fn(async () => input.artifacts),
    saveModelArtifactLineage: vi.fn(async (value: ModelArtifactLineage) => {
      saved = value;
      return value;
    }),
    listModelBindings: vi.fn(async () => []),
  } as unknown as SqliteStore;
  const client = {
    listRegistry: vi.fn(async () => ({
      artifacts: input.registryArtifact ? [input.registryArtifact] : [],
      deployments: input.deployment ? [input.deployment] : [],
    })),
    capabilities: vi.fn(async () => capabilities()),
    syncBinding: vi.fn(async () => undefined),
  } as unknown as ManagedAdapterRegistryClient;
  return {
    service: createManagedAdapterSyncService({
      store,
      client,
      resolveSelectedTeamId: async () => "team_selected",
      now: () => new Date(timestamp),
    }),
    saved: () => saved,
  };
}
