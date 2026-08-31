import { describe, expect, test } from "vitest";
import { TrainingDestinationCapabilitiesSchema } from "../packages/contracts/src";
import { projectBaseModelCandidates } from "../apps/server/src/training/base-model-candidates";
import { createPortableTrainingCatalog } from "../apps/server/src/training/portable-training-catalog";

const checkedAt = "2026-07-19T12:00:00.000Z";

describe("managed base-model candidates", () => {
  test("pins the qualified OpenPond Managed GRPO base profile", () => {
    const candidates = projectBaseModelCandidates({ destinations: [destination()] });
    expect(candidates.map((candidate) => candidate.preference)).toEqual([
      expect.objectContaining({
        modelId: "Qwen/Qwen3-8B",
        revision: "b968826d9c46dd6066d109eabc6255188de91218",
        tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
        chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
      }),
    ]);
  });

  test("preserves managed availability diagnostics", () => {
    const [candidate] = projectBaseModelCandidates({
      destinations: [destination(false, "OpenPond Managed training is not available.")],
    });
    expect(candidate).toMatchObject({
      available: false,
      unavailableReason: "OpenPond Managed training is not available.",
      sourceLabel: "OpenPond Managed",
    });
  });

  test("returns one backend-selected managed target", () => {
    const destinations = [destination()];
    const candidates = projectBaseModelCandidates({ destinations });
    expect(createPortableTrainingCatalog({
      candidates,
      destinations,
      registeredEngineIds: ["sandbox-managed-rl"],
      preferredMethod: "grpo",
      now: checkedAt,
    }).targets).toEqual([
      expect.objectContaining({
        id: "automatic",
        destinationId: "openpond_managed",
        computeAdapterId: "openpond-managed",
        available: true,
      }),
    ]);
  });
});

function destination(available = true, unavailableReason: string | null = null) {
  return TrainingDestinationCapabilitiesSchema.parse({
    schemaVersion: "openpond.trainingDestinationCapabilities.v1",
    destinationId: "openpond_managed",
    available,
    methods: ["grpo"],
    parameterizations: ["lora"],
    modelAllowlist: ["Qwen/Qwen3-8B"],
    maxDatasetBytes: 10_000_000,
    environmentPlacements: ["remote"],
    nonProduction: false,
    unavailableReason,
    checkedAt,
  });
}
