import { describe, expect, test } from "vitest";
import {
  ComputeInventorySchema,
  TrainingDestinationCapabilitiesSchema,
  type TrainingDestinationId,
} from "../packages/contracts/src";
import { projectBaseModelCandidates } from "../apps/server/src/training/base-model-candidates";
import { createPortableTrainingCatalog } from "../apps/server/src/training/portable-training-catalog";

const checkedAt = "2026-07-19T12:00:00.000Z";

describe("provider-neutral base-model candidates", () => {
  test("joins managed catalogs and exact local assets without offering inference-only weights", () => {
    const candidates = projectBaseModelCandidates({
      destinations: [
        destination("fireworks", {
          modelAllowlist: ["accounts/fireworks/models/qwen3-8b"],
          methods: ["sft", "grpo"],
          nonProduction: false,
        }),
        destination("local_cpu_fixture", {
          modelAllowlist: [
            "openpond/tiny-cpu-gpt2-fixture",
            "HuggingFaceTB/SmolLM2-135M-Instruct",
          ],
        }),
      ],
      inventory: inventory(),
    });

    expect(candidates.map((candidate) => candidate.preference.modelId)).toEqual([
      "accounts/fireworks/models/qwen3-8b",
      "HuggingFaceTB/SmolLM2-135M-Instruct",
      "openpond/tiny-cpu-gpt2-fixture",
    ]);
    expect(candidates.find((candidate) =>
      candidate.preference.source === "local")).toMatchObject({
      available: true,
      nonProduction: true,
      preference: {
        modelAssetId: "model_smollm2",
        revision: "12fd25f77366fa6b3b4b768ec3050bf629380bac",
        tokenizerRevision: "tokenizer-smollm2-v1",
      },
      executionOptions: [
        { destinationId: "local_cpu_fixture", available: true },
      ],
    });
    expect(JSON.stringify(candidates)).not.toContain("ollama/qwen-local");
    expect(JSON.stringify(candidates)).not.toContain("/private/model/path");
  });

  test("keeps a known managed model visible with its exact unavailable reason", () => {
    const [candidate] = projectBaseModelCandidates({
      destinations: [
        destination("fireworks", {
          available: false,
          modelAllowlist: ["accounts/fireworks/models/qwen3-8b"],
          nonProduction: false,
          unavailableReason: "Fireworks training credential is not configured.",
        }),
      ],
      inventory: null,
    });

    expect(candidate).toMatchObject({
      available: false,
      unavailableReason: "Fireworks training credential is not configured.",
      sourceLabel: "Fireworks",
    });
  });

  test("pins the qualified OpenPond Managed GRPO base profile exactly", () => {
    const candidates = projectBaseModelCandidates({
      destinations: [
        destination("openpond_managed", {
          modelAllowlist: ["Qwen/Qwen3-0.6B"],
          methods: ["grpo"],
        }),
      ],
      inventory: null,
    });

    expect(
      candidates.map((candidate) => candidate.preference),
    ).toEqual([
      expect.objectContaining({
        modelId: "Qwen/Qwen3-0.6B",
        revision: "c1899de289a04d12100db370d81485cdf75e47ca",
        tokenizerRevision:
          "c1899de289a04d12100db370d81485cdf75e47ca",
        chatTemplateHash:
          "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
      }),
    ]);
  });

  test("returns one backend-selected target for the requested method", () => {
    const destinations = [
      destination("openpond_managed", {
        modelAllowlist: ["Qwen/Qwen3-0.6B"],
        methods: ["grpo"],
      }),
      destination("fireworks", {
        modelAllowlist: ["accounts/fireworks/models/qwen3-8b"],
        methods: ["sft", "grpo"],
        nonProduction: false,
      }),
      destination("local_cpu_fixture", {
        modelAllowlist: ["openpond/tiny-cpu-gpt2-fixture"],
      }),
    ];
    const candidates = projectBaseModelCandidates({
      destinations,
      inventory: null,
    });
    const shared = {
      candidates,
      destinations,
      inventory: null,
      registeredEngineIds: [
        "sandbox-managed-rft",
        "fireworks-native",
        "local-trl",
      ],
      now: checkedAt,
    };

    expect(
      createPortableTrainingCatalog({
        ...shared,
        preferredMethod: "grpo",
      }).targets,
    ).toEqual([
      expect.objectContaining({
        id: "automatic",
        destinationId: "openpond_managed",
        computeAdapterId: "openpond-managed",
        defaults: expect.objectContaining({
          loraRank: 16,
          maxSteps: 2,
          rolloutGroupSize: 4,
          rolloutConcurrency: 4,
        }),
        available: true,
      }),
    ]);
    expect(
      createPortableTrainingCatalog({
        ...shared,
        preferredMethod: "sft",
      }).targets[0],
    ).toMatchObject({
      id: "automatic",
      destinationId: "fireworks",
      computeAdapterId: "fireworks-managed",
      available: true,
    });
  });
});

function destination(
  destinationId: TrainingDestinationId,
  input: {
    available?: boolean;
    methods?: Array<"sft" | "grpo">;
    modelAllowlist: string[];
    nonProduction?: boolean;
    unavailableReason?: string | null;
  },
) {
  return TrainingDestinationCapabilitiesSchema.parse({
    schemaVersion: "openpond.trainingDestinationCapabilities.v1",
    destinationId,
    available: input.available ?? true,
    methods: input.methods ?? ["sft"],
    parameterizations: ["lora"],
    modelAllowlist: input.modelAllowlist,
    maxDatasetBytes: 10_000_000,
    environmentPlacements:
      destinationId === "fireworks"
        ? ["provider_native"]
        : destinationId === "openpond_managed"
          ? ["remote"]
          : ["local"],
    nonProduction: input.nonProduction ?? true,
    unavailableReason: input.unavailableReason ?? null,
    checkedAt,
  });
}

function inventory() {
  return ComputeInventorySchema.parse({
    schemaVersion: "openpond.computeInventory.v1",
    host: {
      platform: "linux",
      architecture: "x64",
      operatingSystem: "Linux",
      hostname: "fixture",
      totalMemoryBytes: 16_000_000_000,
    },
    devices: [],
    runtimes: [],
    storageRoots: [],
    connections: [],
    models: [
      {
        id: "model_smollm2",
        name: "SmolLM2 135M Instruct",
        source: "huggingface",
        path: "/private/model/path",
        modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
        revision: "12fd25f77366fa6b3b4b768ec3050bf629380bac",
        tokenizerRevision: "tokenizer-smollm2-v1",
        chatTemplateHash: "a".repeat(64),
        digest: "b".repeat(64),
        family: "smollm2",
        parameterCount: 135_000_000,
        format: "safetensors",
        quantization: null,
        sizeBytes: 550_000_000,
        inferenceCompatible: true,
        trainingCompatible: true,
        compatibilityReason: null,
        discoveredAt: checkedAt,
      },
      {
        id: "model_ollama",
        name: "Ollama Qwen",
        source: "ollama",
        path: null,
        modelId: "ollama/qwen-local",
        revision: null,
        tokenizerRevision: null,
        chatTemplateHash: null,
        digest: "c".repeat(64),
        family: "qwen",
        parameterCount: null,
        format: "gguf",
        quantization: "q4",
        sizeBytes: null,
        inferenceCompatible: true,
        trainingCompatible: false,
        compatibilityReason: "GGUF is inference-only.",
        discoveredAt: checkedAt,
      },
    ],
    downloads: [],
    warnings: [],
    scannedAt: checkedAt,
  });
}
