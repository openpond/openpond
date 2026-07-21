import { describe, expect, test, vi } from "vitest";
import type {
  ModelArtifactLineage,
  TrainingArtifact,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import {
  MANAGED_QWEN3_8B_BASE_REVISION,
  type ManagedAdapterRegistryClient,
} from "./managed-adapter-registry-client.js";
import { createManagedAdapterSyncService } from "./managed-adapter-sync-service.js";

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
    chatTemplateHash: "2".repeat(64),
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
    listTrainingArtifacts: vi.fn(async () => input.artifacts ?? [
      artifact("config", "adapter_config.json"),
      artifact("weights", "adapter_model.safetensors"),
    ]),
    getTrainingJob: vi.fn(async () => ({
      id: "job-qa",
      planId: "plan-qa",
      metadata: { providerJobId: "provider-run-qa" },
    })),
    getTrainingPlan: vi.fn(async () => ({ id: "plan-qa" })),
    getTrainingArtifact: vi.fn(async (id: string) =>
      id === "source-adapter"
        ? artifact("source-adapter", "adapter_model.safetensors")
        : null,
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
    publishFireworksSource,
    syncBinding: vi.fn(async () => undefined),
  } as unknown as ManagedAdapterRegistryClient;
  const service = createManagedAdapterSyncService({
    store,
    client,
    resolveSelectedTeamId: async () =>
      input.selectedTeamId === undefined
        ? "team_qa"
        : input.selectedTeamId,
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
    const {
      service,
      listRegistry,
      publishFireworksSource,
      saved,
    } = harness({
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

  test("fails closed before upload when the base revision differs", async () => {
    const { service, publishFireworksSource, saved } = harness({
      artifacts: [
        artifact("config", "adapter_config.json", "3".repeat(40)),
        artifact(
          "weights",
          "adapter_model.safetensors",
          "3".repeat(40),
        ),
      ],
    });

    await service.reconcile();

    expect(publishFireworksSource).not.toHaveBeenCalled();
    expect(saved()?.managedServing).toMatchObject({
      state: "failed",
      canonicalArtifactId: null,
    });
    expect(saved()?.managedServing?.lastError).toContain(
      "pinned Qwen/Qwen3-8B",
    );
  });

  test("fails closed without a UI-selected team before registry access or upload", async () => {
    const {
      service,
      listRegistry,
      publishFireworksSource,
      saved,
    } = harness({ selectedTeamId: null });

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
});
