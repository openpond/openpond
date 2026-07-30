import { describe, expect, test, vi } from "vitest";
import type { ModelArtifactLineage, TrainingArtifact } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { type ManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import { createManagedAdapterSyncService } from "./managed-adapter-sync-service.js";

const MANAGED_QWEN3_0_6B_BASE_PROFILE_ID = "qwen3-0-6b-c1899de2";
const MANAGED_QWEN3_0_6B_BASE_REVISION = "c1899de289a04d12100db370d81485cdf75e47ca";
const MANAGED_QWEN3_8B_BASE_PROFILE_ID = "qwen3-8b-b968826d";
const MANAGED_QWEN3_8B_BASE_REVISION = "b968826d9c46dd6066d109eabc6255188de91218";
const MANAGED_QWEN_CHAT_TEMPLATE_HASH =
  "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8";
const timestamp = "2026-07-19T16:00:00.000Z";

function sandboxCapabilities() {
  return {
    schemaVersion: "openpond.modelAdapterPlatformCapabilities.v1" as const,
    baseModelProfileContractVersion: "openpond.baseModelProfile.v2" as const,
    lifecyclePolicyOwner: "sandbox" as const,
    baseProfiles: [
      {
        id: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
        repository: "Qwen/Qwen3-0.6B",
        revision: MANAGED_QWEN3_0_6B_BASE_REVISION,
        tokenizerRevision: MANAGED_QWEN3_0_6B_BASE_REVISION,
        chatTemplateHash: MANAGED_QWEN_CHAT_TEMPLATE_HASH,
        status: "qualified" as const,
      },
      {
        id: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
        repository: "Qwen/Qwen3-8B",
        revision: MANAGED_QWEN3_8B_BASE_REVISION,
        tokenizerRevision: MANAGED_QWEN3_8B_BASE_REVISION,
        chatTemplateHash: MANAGED_QWEN_CHAT_TEMPLATE_HASH,
        status: "qualified" as const,
      },
    ],
  };
}

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

function artifact(
  id: string,
  providerFilename: string,
  baseRevision = MANAGED_QWEN3_8B_BASE_REVISION,
): TrainingArtifact {
  return {
    schemaVersion: "openpond.trainingArtifact.v1",
    id,
    jobId: "job-qa",
    kind: "adapter",
    path: `/tmp/${providerFilename}`,
    sha256: id === "config" ? "f".repeat(64) : "1".repeat(64),
    sizeBytes: id === "config" ? 800 : 80_000_000,
    baseModelId: "Qwen/Qwen3-8B",
    baseModelRevision: baseRevision,
    tokenizerRevision: baseRevision,
    chatTemplateHash: MANAGED_QWEN_CHAT_TEMPLATE_HASH,
    nonProduction: false,
    createdAt: timestamp,
    metadata: {
      provider: "fireworks",
      providerFilename,
    },
  };
}

function harness(input: {
  artifacts?: TrainingArtifact[];
  registryArtifact?: {
    id: string;
    source: string;
    sourceRef: string;
    state: string;
    promotable: boolean;
    customerBindingAllowed: boolean;
  };
  deployment?: { id: string; artifactId: string; state: string };
  managedServing?: NonNullable<ModelArtifactLineage["managedServing"]>;
  selectedTeamId?: string | null;
}) {
  let saved: ModelArtifactLineage | null = null;
  const currentLineage = lineage();
  currentLineage.managedServing = input.managedServing ?? null;
  const store = {
    listModelArtifactLineage: vi.fn(async () => [currentLineage]),
    listTrainingArtifacts: vi.fn(
      async () =>
        input.artifacts ?? [
          artifact("config", "adapter_config.json"),
          artifact("weights", "adapter_model.safetensors"),
        ],
    ),
    getTrainingJob: vi.fn(async () => ({
      id: "job-qa",
      planId: "plan-qa",
      metadata: { providerJobId: "provider-run-qa" },
    })),
    getTrainingPlan: vi.fn(async () => ({ id: "plan-qa" })),
    getTrainingArtifact: vi.fn(async (id: string) =>
      id === "source-adapter" ? artifact("source-adapter", "adapter_model.safetensors") : null,
    ),
    saveModelArtifactLineage: vi.fn(async (value: ModelArtifactLineage) => {
      saved = value;
      return value;
    }),
    listModelBindings: vi.fn(async () => []),
  } as unknown as SqliteStore;
  const publishFireworksSource = vi.fn(async () => ({
    id: "canonical-artifact",
    source: "direct_upload",
    sourceRef: "upload:canonical-artifact",
    state: "imported_unvalidated",
    promotable: false,
    customerBindingAllowed: false,
  }));
  const listRegistry = vi.fn(async () => ({
    artifacts: input.registryArtifact ? [input.registryArtifact] : [],
    deployments: input.deployment ? [input.deployment] : [],
  }));
  const client = {
    listRegistry,
    capabilities: vi.fn(async () => sandboxCapabilities()),
    publishFireworksSource,
    syncBinding: vi.fn(async () => undefined),
  } as unknown as ManagedAdapterRegistryClient;
  const service = createManagedAdapterSyncService({
    store,
    client,
    resolveSelectedTeamId: async () =>
      input.selectedTeamId === undefined ? "team_qa" : input.selectedTeamId,
    now: () => new Date(timestamp),
  });
  return {
    service,
    listRegistry,
    publishFireworksSource,
    saved: () => saved,
  };
}

describe("managed adapter sync service", () => {
  test("publishes an exact pinned Fireworks PEFT adapter through the canonical import", async () => {
    const { service, publishFireworksSource, saved } = harness({});

    await service.reconcile();

    expect(publishFireworksSource).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team_qa",
        lineageId: "lineage-qa",
        trainingJobId: "job-qa",
        trainingPlanId: "plan-qa",
        providerRunId: "provider-run-qa",
        files: expect.arrayContaining([
          expect.objectContaining({ path: "adapter_config.json" }),
          expect.objectContaining({ path: "adapter_model.safetensors" }),
        ]),
      }),
    );
    expect(saved()?.managedServing).toMatchObject({
      teamId: "team_qa",
      canonicalArtifactId: "canonical-artifact",
      state: "imported",
      lastError: null,
    });
  });

  test("projects readiness only after canonical promotion and deployment", async () => {
    const { service, publishFireworksSource, saved } = harness({
      registryArtifact: {
        id: "canonical-artifact",
        source: "openpond_fireworks",
        sourceRef: "lineage-qa",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
      },
      deployment: {
        id: "deployment-qa",
        artifactId: "canonical-artifact",
        state: "ready",
      },
    });

    await service.reconcile();

    expect(publishFireworksSource).not.toHaveBeenCalled();
    expect(saved()?.managedServing).toMatchObject({
      canonicalArtifactId: "canonical-artifact",
      canonicalDeploymentId: "deployment-qa",
      state: "ready",
    });
  });

  test("reuses a desktop direct import through its persisted projection", async () => {
    const { service, listRegistry, publishFireworksSource, saved } = harness({
      selectedTeamId: "team_other",
      managedServing: {
        schemaVersion: "openpond.managedAdapterServingProjection.v1",
        teamId: "team_qa",
        source: "openpond_fireworks",
        sourceRef: "lineage-qa",
        canonicalArtifactId: "canonical-artifact",
        canonicalArtifactState: "imported_unvalidated",
        canonicalDeploymentId: null,
        canonicalDeploymentState: null,
        state: "imported",
        customerBindingAllowed: false,
        artifactContentHash: null,
        baseProfileId: null,
        publishedAt: timestamp,
        lastSyncedAt: timestamp,
        lastError: null,
      },
      registryArtifact: {
        id: "canonical-artifact",
        source: "direct_upload",
        sourceRef: "upload:canonical-artifact",
        state: "imported_unvalidated",
        promotable: false,
        customerBindingAllowed: false,
      },
    });

    await service.reconcile();

    expect(listRegistry).toHaveBeenCalledWith("team_qa");
    expect(publishFireworksSource).not.toHaveBeenCalled();
    expect(saved()?.managedServing).toMatchObject({
      canonicalArtifactId: "canonical-artifact",
      canonicalArtifactState: "imported_unvalidated",
      state: "imported",
      lastError: null,
    });
  });

  test("refreshes a retained OpenPond training projection without republishing bytes", async () => {
    const { service, listRegistry, publishFireworksSource, saved } = harness({
      artifacts: [],
      managedServing: {
        schemaVersion: "openpond.managedAdapterServingProjection.v1",
        teamId: "team_qa",
        source: "openpond_training",
        sourceRef: "lineage-qa",
        canonicalArtifactId: "canonical-artifact",
        canonicalArtifactState: "promotable",
        canonicalDeploymentId: "deployment-retired",
        canonicalDeploymentState: "failed",
        state: "imported",
        customerBindingAllowed: true,
        artifactContentHash: "1".repeat(64),
        baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
        publishedAt: timestamp,
        lastSyncedAt: timestamp,
        lastError: null,
      },
      registryArtifact: {
        id: "canonical-artifact",
        source: "openpond_training",
        sourceRef: "lineage-qa",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
      },
      deployment: {
        id: "deployment-runpod",
        artifactId: "canonical-artifact",
        state: "ready",
      },
    });

    await service.reconcile();

    expect(listRegistry).toHaveBeenCalledWith("team_qa");
    expect(publishFireworksSource).not.toHaveBeenCalled();
    expect(saved()?.managedServing).toMatchObject({
      source: "openpond_training",
      canonicalArtifactId: "canonical-artifact",
      canonicalDeploymentId: "deployment-runpod",
      canonicalDeploymentState: "ready",
      state: "ready",
      baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
      lastError: null,
    });
  });

  test("follows the selected team after a pre-publication failure", async () => {
    const { service, listRegistry, publishFireworksSource, saved } = harness({
      selectedTeamId: "team_current",
      managedServing: {
        schemaVersion: "openpond.managedAdapterServingProjection.v1",
        teamId: "team_stale",
        source: "openpond_fireworks",
        sourceRef: "lineage-qa",
        canonicalArtifactId: null,
        canonicalArtifactState: null,
        canonicalDeploymentId: null,
        canonicalDeploymentState: null,
        state: "failed",
        customerBindingAllowed: false,
        artifactContentHash: null,
        baseProfileId: null,
        publishedAt: null,
        lastSyncedAt: timestamp,
        lastError: "Managed adapter API failed (403): api_key_scope_denied",
      },
    });

    await service.reconcile();

    expect(listRegistry).toHaveBeenCalledWith("team_current");
    expect(publishFireworksSource).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team_current",
      }),
    );
    expect(saved()?.managedServing).toMatchObject({
      teamId: "team_current",
      canonicalArtifactId: "canonical-artifact",
      lastError: null,
    });
  });

  test("fails closed before upload when the base revision differs", async () => {
    const { service, publishFireworksSource, saved } = harness({
      artifacts: [
        artifact("config", "adapter_config.json", "3".repeat(40)),
        artifact("weights", "adapter_model.safetensors", "3".repeat(40)),
      ],
    });

    await service.reconcile();

    expect(publishFireworksSource).not.toHaveBeenCalled();
    expect(saved()?.managedServing).toMatchObject({
      state: "failed",
      canonicalArtifactId: null,
    });
    expect(saved()?.managedServing?.lastError).toContain("Sandbox-qualified base profile");
  });

  test("fails closed without a UI-selected team before registry access or upload", async () => {
    const { service, listRegistry, publishFireworksSource, saved } = harness({
      selectedTeamId: null,
    });

    await service.reconcile();

    expect(listRegistry).not.toHaveBeenCalled();
    expect(publishFireworksSource).not.toHaveBeenCalled();
    expect(saved()?.managedServing).toMatchObject({
      teamId: null,
      state: "failed",
      canonicalArtifactId: null,
      lastError: expect.stringContaining("Select an OpenPond team"),
    });
  });

  test("waits for Sandbox canonical publication without uploading managed bytes", async () => {
    const managed = managedHarness({
      registryArtifact: null,
      deployment: null,
    });

    await managed.service.reconcile();

    expect(managed.listRegistry).toHaveBeenCalledWith("team_managed");
    expect(managed.publishFireworksSource).not.toHaveBeenCalled();
    expect(managed.saved()?.managedServing).toMatchObject({
      teamId: "team_managed",
      source: "sandbox_managed_rl",
      sourceRef: "managed-job-qa",
      state: "failed",
      lastError: expect.stringContaining("canonical publication"),
    });
  });

  test("observes the Sandbox-owned candidate and first deployment", async () => {
    const managed = managedHarness({
      registryArtifact: {
        id: "canonical-artifact",
        source: "sandbox_managed_rl",
        sourceRef: "r2://managed-rl/tenants/team_managed/jobs/managed-job-qa/candidate.json",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
        contentHash: "1".repeat(64),
        baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
      },
      deployment: {
        id: "deployment-managed",
        artifactId: "canonical-artifact",
        state: "ready",
      },
    });

    await managed.service.reconcile();

    expect(managed.publishFireworksSource).not.toHaveBeenCalled();
    expect(managed.saved()?.managedServing).toMatchObject({
      teamId: "team_managed",
      source: "sandbox_managed_rl",
      sourceRef: "managed-job-qa",
      canonicalArtifactId: "canonical-artifact",
      canonicalArtifactState: "promotable",
      canonicalDeploymentId: "deployment-managed",
      canonicalDeploymentState: "ready",
      state: "ready",
      customerBindingAllowed: true,
      artifactContentHash: "1".repeat(64),
      baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
      lastError: null,
    });
  });
});

function managedHarness(input: {
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
  deployment: {
    id: string;
    artifactId: string;
    state: string;
  } | null;
}) {
  const currentLineage = lineage();
  let saved: ModelArtifactLineage | null = null;
  const candidate: TrainingArtifact = {
    schemaVersion: "openpond.trainingArtifact.v1",
    id: "source-adapter",
    jobId: "job-qa",
    kind: "adapter",
    path: "sandbox-managed-rl://managed-job-qa/model-artifact-qa",
    sha256: "4".repeat(64),
    sizeBytes: 8_000_000,
    baseModelId: "Qwen/Qwen3-0.6B",
    baseModelRevision: MANAGED_QWEN3_0_6B_BASE_REVISION,
    tokenizerRevision: MANAGED_QWEN3_0_6B_BASE_REVISION,
    chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
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
  const store = {
    listModelArtifactLineage: vi.fn(async () => [currentLineage]),
    listTrainingArtifacts: vi.fn(async () => [candidate]),
    saveModelArtifactLineage: vi.fn(async (value: ModelArtifactLineage) => {
      saved = value;
      return value;
    }),
    listModelBindings: vi.fn(async () => []),
  } as unknown as SqliteStore;
  const publishFireworksSource = vi.fn();
  const registry = () => ({
    artifacts: input.registryArtifact ? [input.registryArtifact] : [],
    deployments: input.deployment ? [input.deployment] : [],
  });
  const listRegistry = vi.fn(async () => registry());
  const client = {
    listRegistry,
    capabilities: vi.fn(async () => sandboxCapabilities()),
    publishFireworksSource,
    syncBinding: vi.fn(async () => undefined),
  } as unknown as ManagedAdapterRegistryClient;
  return {
    service: createManagedAdapterSyncService({
      store,
      client,
      resolveSelectedTeamId: async () => "team_selected_later",
      now: () => new Date(timestamp),
    }),
    publishFireworksSource,
    listRegistry,
    saved: () => saved,
  };
}
