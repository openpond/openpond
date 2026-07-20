import { describe, expect, test } from "vitest";
import {
  ComputeInventorySchema,
  TrainingDestinationCapabilitiesSchema,
  type TrainingDestinationId,
} from "../packages/contracts/src";
import { projectBaseModelCandidates } from "../apps/server/src/training/base-model-candidates";

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
        destination("local_cuda", {
          available: false,
          modelAllowlist: ["HuggingFaceTB/SmolLM2-135M-Instruct"],
          unavailableReason: "CUDA worker conformance is missing.",
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
        {
          destinationId: "local_cuda",
          available: false,
          unavailableReason: "CUDA worker conformance is missing.",
        },
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
    environmentPlacements: destinationId === "fireworks"
      ? ["provider_native"]
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
