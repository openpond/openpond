import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ComputeSettingsSchema } from "@openpond/contracts";
import { discoverModelAssets } from "../apps/server/src/compute/model-discovery";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("compute model sources", () => {
  test("discovers only recognized models beneath explicitly configured roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-model-source-"));
    temporaryDirectories.push(root);
    const snapshot = path.join(root, "HuggingFaceTB", "SmolLM2-135M-Instruct", "0123456789abcdef");
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, "config.json"), JSON.stringify({ _name_or_path: "HuggingFaceTB/SmolLM2-135M-Instruct", model_type: "smollm", architectures: ["LlamaForCausalLM"] }));
    await writeFile(path.join(snapshot, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ messages }}" }));
    await writeFile(path.join(snapshot, "tokenizer.json"), "{}");
    await writeFile(path.join(snapshot, "model.safetensors"), "fixture");
    await writeFile(path.join(snapshot, "openpond-model.json"), JSON.stringify({ modelId: "HuggingFaceTB/SmolLM2-135M-Instruct", revision: "0123456789abcdef", tokenizerRevision: "0123456789abcdef", chatTemplateHash: "a".repeat(64), parameterCount: 135000000 }));
    await mkdir(path.join(root, "unrelated"));
    await writeFile(path.join(root, "unrelated", "notes.txt"), "not a model");
    const settings = ComputeSettingsSchema.parse({ schemaVersion: "openpond.computeSettings.v1", modelStorePath: root, defaultDeviceIds: [], additionalModelPaths: [], updatedAt: "2026-07-12T12:00:00.000Z" });
    const result = await discoverModelAssets(settings, "2026-07-12T12:00:00.000Z");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ modelId: "HuggingFaceTB/SmolLM2-135M-Instruct", revision: "0123456789abcdef", trainingCompatible: true, format: "safetensors", parameterCount: 135000000 });
  });
});
