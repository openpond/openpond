import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppPreferencesSchema, LocalModelChatConfigurationSchema, SftRecipeSchema, TrainingBundleManifestSchema, TrainingPlanSchema, TrainingRecipeSchema, UnsupportedTrainingRecipeSchema, UpdateAppPreferencesRequestSchema } from "../packages/contracts/src";
import { planFixture, sftRecipeFixture } from "./helpers/training-fixtures";

describe("training contracts", () => {
  test("makes LoRA SFT executable and every other method explicitly unsupported", () => {
    expect(SftRecipeSchema.safeParse(sftRecipeFixture()).success).toBe(true);
    expect(TrainingPlanSchema.safeParse(planFixture()).success).toBe(true);
    const unsupported = UnsupportedTrainingRecipeSchema.parse({ schemaVersion: "openpond.unsupportedRecipe.v1", method: "grpo", parameterization: "lora", unsupportedReason: "Hosted/managed readiness only." });
    expect(TrainingRecipeSchema.parse(unsupported).method).toBe("grpo");
    expect(SftRecipeSchema.safeParse(unsupported).success).toBe(false);
    expect(SftRecipeSchema.safeParse({ ...sftRecipeFixture(), parameterization: "full" }).success).toBe(false);
  });

  test("keeps checked-in Python JSON Schemas generated from the TypeScript source", async () => {
    const generated = JSON.parse(await readFile("python/openpond-training/src/openpond_training/schemas/training-bundle.schema.json", "utf8"));
    expect(generated).toEqual(z.toJSONSchema(TrainingBundleManifestSchema, { target: "draft-7", unrepresentable: "any" }));
  });

  test("persists provider-neutral Task Creator defaults", () => {
    const defaults = AppPreferencesSchema.parse({});
    expect(defaults).toMatchObject({
      defaultChatProvider: "openai",
      defaultChatModel: "gpt-5.6-sol",
      codexReasoningEffort: "high",
    });
    expect(defaults.training).toEqual({
      defaultModelRef: null,
      creationMode: "customize",
      autoApproveEvidence: false,
    });
    expect(UpdateAppPreferencesRequestSchema.parse({ training: {
      defaultModelRef: { providerId: "openai", modelId: "gpt-5.4" },
      creationMode: "defaults",
      autoApproveEvidence: true,
    } }).training?.defaultModelRef?.providerId).toBe("openai");
  });

  test("defaults imported local models to an efficient, bounded chat configuration", () => {
    const configuration = LocalModelChatConfigurationSchema.parse({});
    expect(configuration).toMatchObject({
      profile: "efficient",
      systemPromptMode: "lean",
      contextWindowTokens: 1024,
      maxOutputTokens: 64,
      repetitionPenalty: 1.1,
      noRepeatNgramSize: 3,
      compaction: "when_needed",
      keepWarmSeconds: 300,
    });
  });
});
