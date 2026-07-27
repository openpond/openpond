import {
  BaseModelCandidateSchema,
  ModelRunDraftSchema,
  SignedWorkerCatalogSchema,
  TrainingDestinationCapabilitiesSchema,
} from "@openpond/contracts";
import { sha256 } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import {
  createPortableTrainingCatalog,
  preparePortableModelRun,
} from "../apps/server/src/training/portable-training-catalog.js";
import { destinationLabel } from "../apps/web/src/components/training/training-model-data.js";
import {
  FIXED_TIME,
  sftRecipeFixture,
  tasksetFixture,
} from "./helpers/training-fixtures.js";

describe("server-owned portable training catalog", () => {
  it("presents hosted compute through the OpenPond Managed product boundary", () => {
    const catalog = createPortableTrainingCatalog({
      candidates: [],
      destinations: [],
      inventory: null,
      workerCatalog: null,
      now: FIXED_TIME,
    });
    const managed = catalog.targets.find(
      (target) => target.destinationId === "openpond_managed",
    );

    expect(managed).toMatchObject({
      label: "OpenPond Managed",
      description: "Let OpenPond prepare and operate the compute for this training run.",
      capabilityPills: ["Managed"],
      unavailableReason: "OpenPond Managed is not available for this account.",
    });
    expect(destinationLabel("openpond_managed")).toBe("OpenPond Managed");
    expect([
      managed?.label,
      managed?.description,
      ...(managed?.capabilityPills ?? []),
      managed?.unavailableReason,
    ].join(" ")).not.toMatch(/\b(?:sandbox|latitude|prime|gcp|cloudflare|m8)\b/i);
  });

  it("resolves compute, model, engine, worker preparation without side effects", () => {
    const taskset = tasksetFixture({ ready: true });
    const destination = TrainingDestinationCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingDestinationCapabilities.v1",
      destinationId: "local_cpu_fixture",
      available: true,
      methods: ["sft"],
      parameterizations: ["lora"],
      modelAllowlist: ["openpond/tiny-cpu-gpt2-fixture"],
      maxDatasetBytes: 10_000_000,
      environmentPlacements: ["local"],
      nonProduction: true,
      unavailableReason: null,
      checkedAt: FIXED_TIME,
    });
    const candidate = BaseModelCandidateSchema.parse({
      schemaVersion: "openpond.baseModelCandidate.v1",
      selectionKey: "tiny-cpu",
      label: "Tiny CPU",
      sourceLabel: "This machine",
      preference: {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: "openpond/tiny-cpu-gpt2-fixture",
        revision: "architecture-v2-seed-17-context-512",
        tokenizerRevision: "wordlevel-v1",
        chatTemplateHash: sha256("fixture-template"),
        modelAssetId: null,
        source: "builtin",
      },
      available: true,
      nonProduction: true,
      unavailableReason: null,
      methods: ["sft"],
      executionOptions: [
        {
          destinationId: "local_cpu_fixture",
          available: true,
          methods: ["sft"],
          parameterizations: ["lora"],
          nonProduction: true,
          unavailableReason: null,
        },
      ],
    });
    const catalog = createPortableTrainingCatalog({
      candidates: [candidate],
      destinations: [destination],
      inventory: null,
      workerCatalog: null,
      registeredEngineIds: ["local-trl"],
      now: FIXED_TIME,
    });
    const run = ModelRunDraftSchema.parse({
      schemaVersion: "openpond.modelRunDraft.v1",
      id: "run-1",
      profileId: taskset.profileId,
      modelId: "model-1",
      status: "ready_to_run",
      title: "Local training",
      datasetMode: "existing",
      tasksetRef: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      datasetCreationId: null,
      buildIntent: null,
      buildSpecification: null,
      baseModel: candidate.preference,
      method: "sft",
      destinationId: "local_cpu_fixture",
      runPreset: "small",
      recipe: sftRecipeFixture(),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const preparation = preparePortableModelRun({
      modelRun: run,
      catalog,
      maximumSpendUsd: 0,
    });

    expect(preparation.state).toBe("ready");
    expect(preparation.sideEffectsStarted).toBe(false);
    expect(preparation.compute?.adapterId).toBe("local-cpu");
    expect(preparation.engine?.adapterId).toBe("local-trl");
    expect(catalog.models[0]).toMatchObject({
      cached: true,
      preparationState: "ready",
    });
  });

  it("keeps search-resolved registry Models visible with an exact reason", () => {
    const catalog = createPortableTrainingCatalog({
      candidates: [],
      destinations: [],
      inventory: null,
      workerCatalog: null,
      searchResults: [
        {
          modelId: "org/search-result",
          revision: "0123456789abcdef",
          label: "Search Result",
        },
      ],
      now: FIXED_TIME,
    });

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      modelId: "org/search-result",
      revision: "0123456789abcdef",
      source: "search",
      known: false,
      searchResolved: true,
      preparationState: "unsupported",
    });
    expect(catalog.models[0]?.reason).toContain(
      "tokenizer and chat-template compatibility",
    );
  });

  it("enables a connected engine only for the configured signed image digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const workerCatalog = SignedWorkerCatalogSchema.parse({
      schemaVersion: "openpond.workerCatalog.v1",
      openpondRelease: "0.0.38",
      workerProtocolVersion: "openpond.connectedWorker.v1",
      entries: [
        {
          id: "prime-rl-worker",
          engineAdapterId: "connected-prime-rl",
          workerProtocolVersion: "openpond.connectedWorker.v1",
          openpondReleaseRange: "0.0.38",
          upstreamRevision:
            "e0d60e4d85ea636873acb2e7083e794740d20226",
          image: {
            repository: "us-central1-docker.pkg.dev/openpond/workers/prime-rl",
            digest,
            sizeBytes: 1_000,
            sbomRef: "https://artifacts.example.test/prime-rl.sbom.json",
            sbomSha256: "b".repeat(64),
            signatureRef:
              "https://artifacts.example.test/prime-rl.signature",
          },
          runtime: {
            python: "3.11",
            torch: "2.8.0",
            accelerator: "cuda",
            acceleratorVersion: "12.8",
            architectures: ["linux/amd64"],
          },
          methods: ["grpo"],
          modelFamilies: ["transformers"],
          precisions: ["bf16"],
          conformanceReceipt: {
            ref: "oci://registry.example.test/worker@sha256:" +
              "d".repeat(64),
            sha256: "c".repeat(64),
          },
        },
      ],
      publishedAt: FIXED_TIME,
      contentHash: "d".repeat(64),
      signature: "signature".repeat(4),
      signingKeyId: "worker-key",
    });
    const destination = TrainingDestinationCapabilitiesSchema.parse({
      schemaVersion: "openpond.trainingDestinationCapabilities.v1",
      destinationId: "ssh_gpu",
      available: true,
      methods: ["grpo"],
      parameterizations: ["lora"],
      modelAllowlist: [],
      maxDatasetBytes: null,
      environmentPlacements: ["local"],
      nonProduction: false,
      unavailableReason: null,
      checkedAt: FIXED_TIME,
    });
    const catalog = (configuredDigest: string) =>
      createPortableTrainingCatalog({
        candidates: [],
        destinations: [destination],
        inventory: null,
        workerCatalog,
        registeredEngineIds: ["connected-prime-rl"],
        connectedWorkerConfigured: true,
        connectedEngineConfigured: true,
        connectedWorkerImageDigest: configuredDigest,
        now: FIXED_TIME,
      });

    expect(
      catalog(digest).engines.find(
        (engine) => engine.adapterId === "connected-prime-rl",
      )?.available,
    ).toBe(true);
    expect(
      catalog(`sha256:${"e".repeat(64)}`).engines.find(
        (engine) => engine.adapterId === "connected-prime-rl",
      ),
    ).toMatchObject({
      available: false,
      unavailableReason:
        "The configured worker image does not match the verified signed catalog.",
    });
    expect(
      createPortableTrainingCatalog({
        candidates: [],
        destinations: [destination],
        inventory: null,
        workerCatalog,
        registeredEngineIds: ["connected-prime-rl"],
        connectedEngineConfigured: true,
        connectedWorkerImageDigest: null,
        now: FIXED_TIME,
      }).engines.find(
        (engine) => engine.adapterId === "connected-prime-rl",
      ),
    ).toMatchObject({
      available: true,
      unavailableReason: null,
    });
  });

  it("uses registered compute and runtime capabilities instead of placeholders", () => {
    const catalog = createPortableTrainingCatalog({
      candidates: [],
      destinations: [],
      inventory: null,
      workerCatalog: null,
      sandboxManagedConfigured: true,
      adapterCompute: [
        {
          schemaVersion: "openpond.computeTargetCapabilities.v1",
          adapterId: "prime-raw",
          kind: "managed",
          provider: "prime",
          available: true,
          devices: [
            {
              id: "gpu_1x_h100_sxm5",
              kind: "gpu",
              vendor: "nvidia",
              name: "H100 80 GB",
              memoryBytes: 80_000_000_000,
              runtime: "cuda",
            },
          ],
          supportsWorkerImages: true,
          supportsArtifactTransfer: true,
          supportsCancellation: true,
          capabilityReceipt: "e".repeat(64),
          checkedAt: FIXED_TIME,
          unavailableReason: null,
        },
      ],
      adapterRuntimes: [
        {
          schemaVersion: "openpond.harnessRuntimeCapabilities.v1",
          adapterId: "sandbox-latitude",
          available: false,
          placements: ["remote"],
          lifecycle: [
            "create",
            "reset",
            "step",
            "grade",
            "collect",
            "destroy",
          ],
          deterministicReplay: true,
          privilegedIsolation: true,
          capabilityReceipt: "f".repeat(64),
          checkedAt: FIXED_TIME,
          unavailableReason: "Sandbox maintenance is active.",
        },
      ],
      now: FIXED_TIME,
    });

    expect(
      catalog.compute.find((item) => item.adapterId === "prime-raw"),
    ).toMatchObject({
      available: true,
      devices: [{ id: "gpu_1x_h100_sxm5" }],
    });
    expect(
      catalog.runtimes.find(
        (item) => item.adapterId === "sandbox-latitude",
      ),
    ).toMatchObject({
      available: false,
      unavailableReason: "Sandbox maintenance is active.",
    });
    expect(
      catalog.compute.find(
        (item) => item.adapterId === "sandbox-connected-gpu",
      ),
    ).toMatchObject({
      available: true,
      unavailableReason: null,
    });
  });
});
