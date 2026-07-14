import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelAssetSchema, type ComputeSettings, type ModelAsset } from "@openpond/contracts";

const MAX_DIRECTORIES_PER_ROOT = 400;
const MAX_FILES_PER_MODEL = 1_000;
const MODEL_FILE_PATTERN = /\.(?:safetensors|bin|gguf)$/i;

export async function discoverModelAssets(settings: ComputeSettings, scannedAt: string): Promise<{ models: ModelAsset[]; warnings: string[] }> {
  const warnings: string[] = [];
  const roots = uniqueRoots([
    { path: path.join(os.homedir(), ".cache", "huggingface", "hub"), source: "huggingface" as const, maxDepth: 3 },
    ...(settings.modelStorePath ? [{ path: settings.modelStorePath, source: "local" as const, maxDepth: 4 }] : []),
    ...settings.additionalModelPaths.map((candidate) => ({ path: candidate, source: candidate.toLowerCase().includes("mlx") ? "mlx" as const : "local" as const, maxDepth: 3 })),
  ]);
  const local = (await Promise.all(roots.map(async (root) => {
    try { return await discoverDirectories(root, scannedAt); }
    catch (error) { warnings.push(`Model source ${root.path} could not be inspected: ${message(error)}`); return []; }
  }))).flat();
  const ollama = await discoverOllama(scannedAt).catch((error) => {
    if (!isConnectionFailure(error)) warnings.push(`Ollama model discovery failed: ${message(error)}`);
    return [];
  });
  const unique = new Map<string, ModelAsset>();
  for (const model of [...local, ...ollama]) unique.set(model.path ? `${model.source}:${path.resolve(model.path)}` : `${model.source}:${model.digest ?? model.modelId ?? model.id}`, model);
  return { models: [...unique.values()], warnings };
}

async function discoverDirectories(root: { path: string; source: "huggingface" | "mlx" | "local"; maxDepth: number }, scannedAt: string): Promise<ModelAsset[]> {
  const pending = [{ directory: path.resolve(root.path), depth: 0 }];
  const models: ModelAsset[] = [];
  let visited = 0;
  while (pending.length && visited < MAX_DIRECTORIES_PER_ROOT) {
    const next = pending.shift()!;
    visited += 1;
    const entries = await readdir(next.directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && entry.name === "config.json")) {
      const model = await inspectModelDirectory(next.directory, root.source, scannedAt, entries.map((entry) => entry.name));
      if (model) models.push(model);
      continue;
    }
    if (next.depth >= root.maxDepth) continue;
    for (const entry of entries.slice(0, MAX_DIRECTORIES_PER_ROOT)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      pending.push({ directory: path.join(next.directory, entry.name), depth: next.depth + 1 });
    }
  }
  return models;
}

async function inspectModelDirectory(directory: string, sourceHint: "huggingface" | "mlx" | "local", scannedAt: string, names: string[]): Promise<ModelAsset | null> {
  let config: Record<string, unknown>;
  try { config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")) as Record<string, unknown>; }
  catch { return null; }
  const tokenizerConfig = await readJson(path.join(directory, "tokenizer_config.json"));
  const metadata = await readJson(path.join(directory, "openpond-model.json"));
  const allNames = names.slice(0, MAX_FILES_PER_MODEL);
  const weightNames = allNames.filter((name) => MODEL_FILE_PATTERN.test(name));
  const format = weightNames.some((name) => name.endsWith(".safetensors")) ? "safetensors" : weightNames.some((name) => name.endsWith(".gguf")) ? "gguf" : weightNames.some((name) => name.endsWith(".bin")) ? "pytorch" : sourceHint === "mlx" ? "mlx" : "unknown";
  const hasTokenizer = allNames.some((name) => ["tokenizer.json", "tokenizer.model", "tokenizer_config.json"].includes(name));
  const hasChatTemplate = typeof tokenizerConfig.chat_template === "string" && tokenizerConfig.chat_template.trim().length > 0;
  const source = format === "mlx" || sourceHint === "mlx" ? "mlx" : sourceHint === "huggingface" || isHuggingFaceSnapshot(directory) ? "huggingface" : "local";
  const modelId = stringValue(metadata.modelId) ?? stringValue(config._name_or_path) ?? huggingFaceModelId(directory);
  const revision = stringValue(metadata.revision) ?? snapshotRevision(directory);
  const tokenizerRevision = stringValue(metadata.tokenizerRevision) ?? revision;
  const chatTemplateHash = stringValue(metadata.chatTemplateHash) ?? (hasChatTemplate ? hash(String(tokenizerConfig.chat_template)) : null);
  const sizeBytes = await directoryModelBytes(directory, weightNames, allNames);
  const family = stringValue(config.model_type) ?? firstString(config.architectures);
  const trainingCompatible = format === "safetensors" && hasTokenizer;
  const digest = revision && /^[a-f0-9]{8,64}$/i.test(revision) ? revision : null;
  return ModelAssetSchema.parse({
    id: `model:${hash(`${source}:${directory}`).slice(0, 24)}`,
    name: modelId ?? path.basename(directory),
    source,
    path: directory,
    modelId,
    revision,
    tokenizerRevision,
    chatTemplateHash,
    digest,
    family,
    parameterCount: positiveInteger(metadata.parameterCount) ?? positiveInteger(config.num_parameters),
    format,
    quantization: stringValue(config.quantization_config && typeof config.quantization_config === "object" ? (config.quantization_config as Record<string, unknown>).quant_method : null),
    sizeBytes,
    inferenceCompatible: weightNames.length > 0 && hasTokenizer,
    trainingCompatible,
    compatibilityReason: trainingCompatible ? (hasChatTemplate ? "Safetensors, tokenizer, and chat template detected." : "Safetensors and tokenizer detected; the recipe must supply or validate a chat template.") : format === "gguf" ? "GGUF is available for inference but is not a directly trainable base weight format." : "A supported tokenizer and Safetensors weights are required for local training.",
    discoveredAt: scannedAt,
  });
}

async function discoverOllama(scannedAt: string): Promise<ModelAsset[]> {
  const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { models?: Array<Record<string, unknown>> };
  return (payload.models ?? []).flatMap((model) => {
    const name = stringValue(model.name) ?? stringValue(model.model);
    if (!name) return [];
    const details = model.details && typeof model.details === "object" ? model.details as Record<string, unknown> : {};
    return [ModelAssetSchema.parse({
      id: `model:ollama:${hash(name).slice(0, 20)}`,
      name,
      source: "ollama",
      path: null,
      modelId: name,
      revision: null,
      tokenizerRevision: null,
      chatTemplateHash: null,
      digest: stringValue(model.digest),
      family: stringValue(details.family),
      parameterCount: null,
      format: "gguf",
      quantization: stringValue(details.quantization_level),
      sizeBytes: nonnegativeInteger(model.size),
      inferenceCompatible: true,
      trainingCompatible: false,
      compatibilityReason: "Ollama/GGUF assets are available for inference and baselines, not direct LoRA training.",
      discoveredAt: scannedAt,
    })];
  });
}

async function directoryModelBytes(directory: string, weights: string[], allNames: string[]): Promise<number | null> {
  const relevant = [...new Set([...weights, ...allNames.filter((name) => /^(?:config|tokenizer|special_tokens_map|generation_config).*\.json$/.test(name))])].slice(0, MAX_FILES_PER_MODEL);
  let total = 0;
  for (const name of relevant) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}

function uniqueRoots<T extends { path: string }>(roots: T[]): T[] { const seen = new Set<string>(); return roots.filter((root) => { const resolved = path.resolve(root.path); if (seen.has(resolved)) return false; seen.add(resolved); return true; }); }
function isHuggingFaceSnapshot(directory: string): boolean { return directory.split(path.sep).some((segment) => segment.startsWith("models--")) && directory.split(path.sep).includes("snapshots"); }
function huggingFaceModelId(directory: string): string | null { const segment = directory.split(path.sep).find((part) => part.startsWith("models--")); return segment ? segment.slice("models--".length).replaceAll("--", "/") : null; }
function snapshotRevision(directory: string): string | null { const parts = directory.split(path.sep); const index = parts.lastIndexOf("snapshots"); return index >= 0 && parts[index + 1] ? parts[index + 1]! : null; }
async function readJson(filePath: string): Promise<Record<string, unknown>> { try { const value = JSON.parse(await readFile(filePath, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function firstString(value: unknown): string | null { return Array.isArray(value) ? stringValue(value[0]) : null; }
function positiveInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }
function nonnegativeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isConnectionFailure(error: unknown): boolean { const text = message(error).toLowerCase(); return text.includes("fetch failed") || text.includes("abort") || text.includes("refused"); }
