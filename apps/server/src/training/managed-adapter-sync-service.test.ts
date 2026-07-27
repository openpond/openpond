import { describe, expect, test, vi } from "vitest";
import type {
  ModelArtifactLineage,
  TrainingArtifact,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import {
  MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
  MANAGED_QWEN3_0_6B_BASE_REVISION,
  MANAGED_QWEN3_8B_BASE_PROFILE_ID,
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
      servingPools: [],
      servingReceipts: [],
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
        artifactContentHash: null,
        baseProfileId: null,
        evaluation: null,
        deployment: null,
        servingPool: null,
        servingReceipts: [],
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

  test("follows the selected team after a pre-publication failure", async () => {
    const {
      service,
      listRegistry,
      publishFireworksSource,
      saved,
    } = harness({
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
        artifactContentHash: null,
        baseProfileId: null,
        evaluation: null,
        deployment: null,
        servingPool: null,
        servingReceipts: [],
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

  test("publishes Prime GRPO lineage through signed trusted provenance and requests Sandbox evaluation", async () => {
    const prime = primeHarness({
      registryArtifact: null,
      deployment: null,
    });

    await prime.service.reconcile();

    expect(
      prime.publishTrustedOpenPondTrainingSource,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team_qa",
        lineageId: "lineage-qa",
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "adapter_config.json",
          }),
          expect.objectContaining({
            path: "adapter_model.safetensors",
          }),
        ]),
        provenance: expect.objectContaining({
          sourceSystem: "openpond_training",
          trainingMethod: "grpo",
          modelProjectId: "model-qa",
          modelRunId: "job-qa",
          modelVersionId: "model-version-1",
          providerRunId: "job-qa",
          primeRlRevision:
            "e0d60e4d85ea636873acb2e7083e794740d20226",
        }),
      }),
    );
    expect(prime.requestEvaluation).toHaveBeenCalledWith({
      teamId: "team_qa",
      artifactId: "canonical-artifact",
      role: "chat_manual",
    });
    expect(prime.deployArtifact).not.toHaveBeenCalled();
    expect(prime.saved()?.managedServing).toMatchObject({
      source: "openpond_training",
      canonicalArtifactState: "evaluating",
      state: "imported",
      lastError: null,
    });
  });

  test("delegates promotion to Sandbox when the source benchmark has not run", async () => {
    const prime = primeHarness({
      registryArtifact: null,
      deployment: null,
      withEvaluation: false,
      localPromotable: false,
    });

    await prime.service.reconcile();

    expect(
      prime.publishTrustedOpenPondTrainingSource,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.not.objectContaining({
          evaluationArtifactId: expect.anything(),
          evaluationArtifactSha256: expect.anything(),
          frozenEvaluatorHash: expect.anything(),
        }),
      }),
    );
    expect(prime.requestEvaluation).toHaveBeenCalledWith({
      teamId: "team_qa",
      artifactId: "canonical-artifact",
      role: "chat_manual",
    });
  });

  test("requests one deployment after the canonical Sandbox gate promotes the Prime adapter", async () => {
    const prime = primeHarness({
      registryArtifact: {
        id: "canonical-artifact",
        source: "openpond_training",
        sourceRef: "lineage-qa",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
      },
      deployment: null,
    });

    await prime.service.reconcile();

    expect(
      prime.publishTrustedOpenPondTrainingSource,
    ).not.toHaveBeenCalled();
    expect(prime.listTrustedRegistry).toHaveBeenCalledWith("team_qa");
    expect(prime.listRegistry).not.toHaveBeenCalled();
    expect(prime.requestEvaluation).not.toHaveBeenCalled();
    expect(prime.deployArtifact).toHaveBeenCalledWith({
      teamId: "team_qa",
      artifactId: "canonical-artifact",
      idleTimeoutSeconds: 300,
    });
    expect(prime.saved()?.managedServing).toMatchObject({
      source: "openpond_training",
      canonicalDeploymentId: "deployment-prime",
      canonicalDeploymentState: "requested",
      state: "imported",
    });
  });

  test.each(["failed", "deleted"])(
    "does not silently reprovision after a canonical deployment is %s",
    async (state) => {
      const prime = primeHarness({
        registryArtifact: {
          id: "canonical-artifact",
          source: "openpond_training",
          sourceRef: "lineage-qa",
          state: "promotable",
          promotable: true,
          customerBindingAllowed: true,
        },
        deployment: {
          id: `deployment-${state}`,
          artifactId: "canonical-artifact",
          state,
        },
      });

      await prime.service.reconcile();

      expect(prime.deployArtifact).not.toHaveBeenCalled();
      expect(prime.saved()?.managedServing).toMatchObject({
        canonicalDeploymentId: `deployment-${state}`,
        canonicalDeploymentState: state,
        state: "imported",
      });
    },
  );

  test("retains Sandbox admission and serving receipts after the paid deployment is offline", async () => {
    const prime = primeHarness({
      registryArtifact: {
        id: "canonical-artifact",
        source: "openpond_training",
        sourceRef: "lineage-qa",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
        contentHash: "1".repeat(64),
        baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
        evaluation: {
          passed: true,
          compatibility: { passed: true },
          evidenceHash: "2".repeat(64),
        },
      },
      deployment: {
        id: "deployment-failed",
        artifactId: "canonical-artifact",
        state: "failed",
        evidence: {
          id: "deployment-failed",
          poolId: "pool-1",
          state: "failed",
        },
      },
      servingPools: [{
        id: "pool-1",
        estimatedHourlyUsd: "1.290000",
      }],
      servingReceipts: [{
        requestId: "request-warm",
        artifactId: "canonical-artifact",
        deploymentId: "deployment-failed",
        poolId: "pool-1",
        receipt: {
          contentHash: "3".repeat(64),
          timestamps: {
            completedAt: "2026-07-27T05:00:00.000Z",
          },
        },
      }],
    });

    await prime.service.reconcile();

    expect(prime.deployArtifact).not.toHaveBeenCalled();
    expect(prime.saved()?.managedServing).toMatchObject({
      canonicalArtifactState: "promotable",
      canonicalDeploymentState: "failed",
      state: "imported",
      artifactContentHash: "1".repeat(64),
      baseProfileId: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
      evaluation: {
        passed: true,
        evidenceHash: "2".repeat(64),
      },
      deployment: {
        id: "deployment-failed",
        state: "failed",
      },
      servingPool: {
        id: "pool-1",
        estimatedHourlyUsd: "1.290000",
      },
      servingReceipts: [{
        requestId: "request-warm",
        receipt: { contentHash: "3".repeat(64) },
      }],
    });
  });

  test("leaves the last trusted Prime projection untouched in an ordinary local runtime", async () => {
    const prime = primeHarness({
      registryArtifact: {
        id: "canonical-artifact",
        source: "openpond_training",
        sourceRef: "lineage-qa",
        state: "promotable",
        promotable: true,
        customerBindingAllowed: true,
      },
      deployment: {
        id: "deployment-failed",
        artifactId: "canonical-artifact",
        state: "failed",
      },
      trustedControlAvailable: false,
    });

    await prime.service.reconcile();

    expect(prime.listTrustedRegistry).not.toHaveBeenCalled();
    expect(prime.deployArtifact).not.toHaveBeenCalled();
    expect(prime.saved()).toBeNull();
  });

  test("publishes OpenPond-trained 8B lineage into the distinct 8B pool", async () => {
    const prime = primeHarness({
      registryArtifact: null,
      deployment: null,
      base: "8b",
    });

    await prime.service.reconcile();

    expect(
      prime.publishTrustedOpenPondTrainingSource,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        baseProfileId: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
      }),
    );
  });
});

function primeHarness(input: {
  registryArtifact: {
    id: string;
    source: string;
    sourceRef: string;
    state: string;
    promotable: boolean;
    customerBindingAllowed: boolean;
    contentHash?: string;
    baseProfileId?: string;
    evaluation?: Record<string, unknown>;
  } | null;
  deployment: {
    id: string;
    artifactId: string;
    state: string;
    evidence?: Record<string, unknown>;
  } | null;
  servingPools?: Array<Record<string, unknown>>;
  servingReceipts?: Array<Record<string, unknown>>;
  base?: "0.6b" | "8b";
  withEvaluation?: boolean;
  localPromotable?: boolean;
  trustedControlAvailable?: boolean;
}) {
  const currentLineage = lineage();
  currentLineage.promotable =
    input.localPromotable ?? true;
  currentLineage.frozenEvaluationArtifactId =
    input.withEvaluation === false
      ? null
      : "evaluation-artifact";
  let saved: ModelArtifactLineage | null = null;
  const hash = (character: string) => character.repeat(64);
  const baseProfile = input.base === "8b"
    ? {
        id: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
        modelId: "Qwen/Qwen3-8B",
        revision: MANAGED_QWEN3_8B_BASE_REVISION,
      }
    : {
        id: MANAGED_QWEN3_0_6B_BASE_PROFILE_ID,
        modelId: "Qwen/Qwen3-0.6B",
        revision: MANAGED_QWEN3_0_6B_BASE_REVISION,
      };
  const primeArtifact = (
    id: string,
    providerFilename: string,
    kind: TrainingArtifact["kind"],
  ): TrainingArtifact => ({
    schemaVersion: "openpond.trainingArtifact.v1",
    id,
    jobId: "job-qa",
    kind,
    path: `/tmp/${providerFilename}`,
    sha256: id === "config" ? hash("3") : hash("4"),
    sizeBytes: id === "config" ? 800 : 8_000_000,
    baseModelId: baseProfile.modelId,
    baseModelRevision: baseProfile.revision,
    tokenizerRevision: baseProfile.revision,
    chatTemplateHash:
      "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
    nonProduction: false,
    createdAt: timestamp,
    metadata: {
      provider: "prime",
      providerFilename,
      manifestHash: hash("5"),
      groupedGrpoReceiptHash: hash("6"),
    },
  });
  const config = primeArtifact(
    "config",
    "adapter_config.json",
    "manifest",
  );
  const weights = primeArtifact(
    "source-adapter",
    "adapter_model.safetensors",
    "adapter",
  );
  const evaluation: TrainingArtifact = {
    ...primeArtifact(
      "evaluation-artifact",
      "marketing-benchmark-receipt.json",
      "evaluation",
    ),
    sha256: hash("7"),
    metadata: {
      benchmarkSpecificationHash: hash("8"),
    },
  };
  const store = {
    listModelArtifactLineage: vi.fn(async () => [
      currentLineage,
    ]),
    listTrainingArtifacts: vi.fn(async () => [
      config,
      weights,
    ]),
    getTrainingJob: vi.fn(async () => ({
      id: "job-qa",
      planId: "plan-qa",
      metadata: { finalPolicyVersion: 1 },
    })),
    getTrainingPlan: vi.fn(async () => ({
      id: "plan-qa",
      contentHash: hash("9"),
    })),
    getTrainingArtifact: vi.fn(async (id: string) =>
      id === weights.id
        ? weights
        : id === evaluation.id
        ? evaluation
        : null
    ),
    listModelRuns: vi.fn(async () => [{
      id: "job-qa",
      modelId: "model-qa",
      modelVersionId: "model-version-1",
      status: "succeeded",
      quote: {
        maximumSpendUsd: 1,
        hourlyCostUsd: 0.5,
      },
      receipt: {
        provider: "prime",
        providerRunId: "job-qa",
        resultHash: hash("a"),
        traceHash: hash("b"),
        cleanup: {
          computeReleased: true,
          tunnelClosed: true,
        },
        telemetry: null,
      },
      adapterArtifactLineageId: "lineage-qa",
    }]),
    getModelVersion: vi.fn(async () => ({
      id: "model-version-1",
      modelId: "model-qa",
      kind: "lora_adapter",
      artifactLineageId: "lineage-qa",
      baseModel: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: baseProfile.modelId,
        revision: baseProfile.revision,
        tokenizerRevision: baseProfile.revision,
        chatTemplateHash:
          "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
        modelAssetId: null,
        source: "managed",
      },
      releaseGraph: {
        profileRelease: { contentHash: hash("c") },
        harnessRelease: { contentHash: hash("d") },
        agentRelease: { contentHash: hash("e") },
        grader: { contentHash: hash("f") },
      },
    })),
    saveModelArtifactLineage: vi.fn(
      async (value: ModelArtifactLineage) => {
        saved = value;
        return value;
      },
    ),
    listModelBindings: vi.fn(async () => []),
  } as unknown as SqliteStore;
  const publishTrustedOpenPondTrainingSource = vi.fn(
    async () => ({
      id: "canonical-artifact",
      source: "openpond_training",
      sourceRef: "lineage-qa",
      state: "imported_unvalidated",
      promotable: false,
      customerBindingAllowed: false,
    }),
  );
  const requestEvaluation = vi.fn(async () => undefined);
  const deployArtifact = vi.fn(async () => ({
    id: "deployment-prime",
    artifactId: "canonical-artifact",
    state: "requested",
  }));
  const registry = () => ({
    artifacts: input.registryArtifact
      ? [input.registryArtifact]
      : [],
    deployments: input.deployment ? [input.deployment] : [],
    servingPools: input.servingPools ?? [],
    servingReceipts: input.servingReceipts ?? [],
  });
  const listRegistry = vi.fn(async () => registry());
  const listTrustedRegistry = vi.fn(async () => registry());
  const client = {
    listRegistry,
    listTrustedRegistry,
    publishTrustedOpenPondTrainingSource,
    requestEvaluation,
    deployArtifact,
    syncBinding: vi.fn(async () => undefined),
  } as unknown as ManagedAdapterRegistryClient;
  return {
    service: createManagedAdapterSyncService({
      store,
      client,
      resolveSelectedTeamId: async () => "team_qa",
      trustedControlAvailable: () =>
        input.trustedControlAvailable ?? true,
      now: () => new Date(timestamp),
    }),
    publishTrustedOpenPondTrainingSource,
    requestEvaluation,
    deployArtifact,
    listRegistry,
    listTrustedRegistry,
    saved: () => saved,
  };
}
