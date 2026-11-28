import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash, sha256 } from "@openpond/harness";
import { LocalTrainingModelBaseSchema } from "@openpond/contracts/resource-setup";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const weights = "model.safetensors";
const weightIndex = "model.safetensors.index.json";
const weightShard = /^model-[0-9]{5}-of-[0-9]{5}\.safetensors$/;
const coreFiles = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const optionalFiles = ["chat_template.jinja", "generation_config.json", "special_tokens_map.json", "added_tokens.json"];
const supported = { qwen2: "Qwen2ForCausalLM", qwen3: "Qwen3ForCausalLM", llama: "LlamaForCausalLM" } as const;
const familySchema = z.enum(["qwen2", "qwen3", "llama"]);
const objectSchema = z.record(z.string(), z.unknown());
const fileSchema = z.object({
  name: z.string().refine(name => [weights, weightIndex, ...coreFiles, ...optionalFiles].includes(name) || weightShard.test(name)),
  sizeBytes: z.number().int().positive().safe(),
  sha256: hash,
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal("openpond.localTrainingModel.v1"),
  family: familySchema,
  tokenizerRevision: hash,
  chatTemplateHash: hash,
  files: z.array(fileSchema).min(4).max(256),
}).strict();
const recordSchema = z.object({ manifest: manifestSchema, label: LocalTrainingModelBaseSchema.shape.label }).strict();
const indexSchema = z.object({ weight_map: z.record(z.string().min(1), z.string().regex(weightShard)) });
const dtypeBytes = { BOOL: 1, U8: 1, I8: 1, I16: 2, U16: 2, I32: 4, U32: 4, I64: 8, U64: 8, F16: 2, BF16: 2, F32: 4, F64: 8 } as const;
const dimension = z.number().int().nonnegative().safe();
const tensorSchema = z.object({
  dtype: z.enum(Object.keys(dtypeBytes) as (keyof typeof dtypeBytes)[]),
  shape: z.array(dimension).max(32),
  data_offsets: z.tuple([dimension, dimension]),
});
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const jsonLimit = 64 * 1024 * 1024;

export class LocalTrainingModelError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function present(filename: string) {
  return lstat(filename).then(() => true, error => { if (missing(error)) return false; throw error; });
}

async function readSmall(filename: string) {
  const file = await open(filename, noFollow);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > jsonLimit) {
      throw new LocalTrainingModelError("The checkpoint has an empty or oversized metadata file.");
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new LocalTrainingModelError("The checkpoint changed while reading its metadata.");
    return buffer.toString("utf8");
  } finally { await file.close(); }
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readSmall(filename));
}

async function layout(directory: string) {
  const [single, indexed, namedTemplates, ...optional] = await Promise.all(
    [weights, weightIndex, "additional_chat_templates", ...optionalFiles].map(name => present(path.join(directory, name))),
  );
  if (single === indexed) throw new LocalTrainingModelError("Select a checkpoint with one safetensors file or one safetensors shard index.");
  if (namedTemplates) throw new LocalTrainingModelError("Select a checkpoint with a single chat template.");
  const index = indexed ? indexSchema.parse(await readJson(path.join(directory, weightIndex))).weight_map : null;
  const shards = index ? [...new Set(Object.values(index))] : [];
  if (index && (!shards.length || shards.length > 247)) throw new LocalTrainingModelError("The checkpoint has an invalid shard index.");
  return {
    names: [...coreFiles, ...optionalFiles.filter((_, i) => optional[i]), ...(index ? [weightIndex, ...shards] : [weights])].sort(),
    index,
  };
}

async function weightNames(filename: string) {
  const file = await open(filename, noFollow);
  try {
    const stat = await file.stat();
    const prefix = Buffer.alloc(8);
    if (!stat.isFile() || (await file.read(prefix, 0, prefix.length, 0)).bytesRead !== 8) {
      throw new LocalTrainingModelError("The checkpoint has an incomplete safetensors file.");
    }
    const headerSize = prefix.readBigUInt64LE();
    if (headerSize < 2n || headerSize > BigInt(jsonLimit) || headerSize + 8n >= BigInt(stat.size)) {
      throw new LocalTrainingModelError("The checkpoint has an invalid safetensors header.");
    }
    const header = Buffer.alloc(Number(headerSize));
    if ((await file.read(header, 0, header.length, 8)).bytesRead !== header.length) {
      throw new LocalTrainingModelError("The checkpoint has an incomplete safetensors header.");
    }
    const ranges = Object.entries(objectSchema.parse(JSON.parse(header.toString("utf8"))))
      .filter(([name]) => name !== "__metadata__").map(([name, value]) => ({ name, ...tensorSchema.parse(value) }))
      .sort((a, b) => a.data_offsets[0] - b.data_offsets[0] || a.data_offsets[1] - b.data_offsets[1]);
    let end = 0;
    for (const { data_offsets: [start, next], shape, dtype } of ranges) {
      const size = shape.reduce((elements, value) => elements * BigInt(value), BigInt(dtypeBytes[dtype]));
      if (start !== end || BigInt(next - start) !== size) throw new LocalTrainingModelError("The checkpoint has invalid safetensors offsets.");
      end = next;
    }
    if (end !== stat.size - header.length - 8) throw new LocalTrainingModelError("The checkpoint has incomplete safetensors weights.");
    return ranges.map(item => item.name);
  } finally { await file.close(); }
}

async function buildManifest(directory: string, files: z.infer<typeof fileSchema>[]) {
  const { names, index } = await layout(directory);
  const [config, tokenizer, tokenizerConfig] = await Promise.all(coreFiles.map(async name =>
    objectSchema.parse(await readJson(path.join(directory, name)))));
  const family = familySchema.safeParse(config?.model_type);
  if (!family.success || !Array.isArray(config?.architectures) || !config.architectures.includes(supported[family.data]) ||
    config.auto_map || config.quantization_config || tokenizerConfig?.auto_map || !tokenizer?.model) {
    throw new LocalTrainingModelError("Select a dense Qwen2, Qwen3, or Llama causal model with its standard fast tokenizer.");
  }
  const template = names.includes("chat_template.jinja")
    ? await readSmall(path.join(directory, "chat_template.jinja")) : tokenizerConfig?.chat_template;
  if (typeof template !== "string" || !template.trim()) throw new LocalTrainingModelError("The checkpoint needs a single chat template.");
  if (index) {
    const seen = new Set<string>();
    for (const shard of names.filter(name => weightShard.test(name))) {
      for (const key of await weightNames(path.join(directory, shard))) {
        if (index[key] !== shard || seen.has(key)) throw new LocalTrainingModelError("The shard index does not match the safetensors weights.");
        seen.add(key);
      }
    }
    if (seen.size !== Object.keys(index).length) throw new LocalTrainingModelError("The checkpoint is missing weights from its shard index.");
  } else {
    await weightNames(path.join(directory, weights));
  }
  return manifestSchema.parse({
    schemaVersion: "openpond.localTrainingModel.v1",
    family: family.data,
    tokenizerRevision: contentHash(files.filter(file => ![weights, weightIndex, "config.json", "generation_config.json"].includes(file.name) && !weightShard.test(file.name))),
    chatTemplateHash: sha256(template),
    files,
  });
}

async function scanFile(directory: string, name: string, signal?: AbortSignal, target?: string) {
  const file = await open(path.join(directory, name), noFollow);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LocalTrainingModelError("Checkpoint files must be nonempty regular files.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const copy = target ? await open(path.join(target, name), "wx", 0o600) : null;
    let sizeBytes = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        sizeBytes += bytesRead;
        if (BigInt(sizeBytes) > before.size) throw new LocalTrainingModelError("The checkpoint grew while reading it.");
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        if (copy) await copy.writeFile(chunk, { signal });
      }
      await copy?.sync();
    } finally { await copy?.close(); }
    const after = await file.stat({ bigint: true });
    if (BigInt(sizeBytes) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new LocalTrainingModelError("The checkpoint changed while reading it.");
    }
    return { name, sha256: digest.digest("hex"), sizeBytes };
  } finally { await file.close(); }
}

function summarize(id: string, { manifest, label }: z.infer<typeof recordSchema>) {
  return LocalTrainingModelBaseSchema.parse({
    label,
    sizeBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    preference: {
      schemaVersion: "openpond.baseModelPreference.v1",
      modelId: `local/${manifest.family}/${id}`,
      source: "local",
      modelAssetId: id,
      revision: id,
      tokenizerRevision: manifest.tokenizerRevision,
      chatTemplateHash: manifest.chatTemplateHash,
    },
  });
}

export function localTrainingModelAssets(storeDir: string) {
  const root = path.resolve(storeDir, "training", "local-models");
  async function read(id: string) {
    const directory = path.join(root, hash.parse(id));
    if (!(await lstat(directory)).isDirectory()) throw new LocalTrainingModelError("The saved checkpoint is unavailable.", 404);
    const record = recordSchema.parse(await readJson(path.join(directory, "manifest.json")));
    if (contentHash(record.manifest) !== id) throw new LocalTrainingModelError("The saved checkpoint manifest changed.", 409);
    return { directory, record };
  }
  async function verify(id: string, signal?: AbortSignal) {
    try {
      const { directory, record } = await read(id);
      const modelDirectory = path.join(directory, "files");
      if (!(await lstat(modelDirectory)).isDirectory()) throw new LocalTrainingModelError("The saved checkpoint files are unavailable.", 409);
      const entries = await readdir(modelDirectory);
      if (entries.length !== record.manifest.files.length || record.manifest.files.some(file => !entries.includes(file.name))) {
        throw new LocalTrainingModelError("The saved checkpoint file list changed.", 409);
      }
      for (const expected of record.manifest.files) {
        const actual = await scanFile(modelDirectory, expected.name, signal);
        if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
          throw new LocalTrainingModelError("The saved checkpoint failed its checksum.", 409);
        }
      }
      return { base: summarize(id, record), modelDirectory };
    } catch (error) {
      if (error instanceof LocalTrainingModelError) throw error;
      throw new LocalTrainingModelError("The saved checkpoint could not be verified.", 409);
    }
  }
  return {
    verify,
    async inspect(id: string) {
      const { record } = await read(id);
      return summarize(id, record);
    },
    async list() {
      const entries = await readdir(root, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error; });
      const bases = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !hash.safeParse(entry.name).success) continue;
        try { bases.push(summarize(entry.name, (await read(entry.name)).record)); }
        catch { /* Ignore unavailable manifests in the picker. Exact lookup reports the failure. */ }
      }
      return bases.sort((a, b) => a.label.localeCompare(b.label) || a.preference.revision.localeCompare(b.preference.revision));
    },
    async import(directory: string, signal?: AbortSignal) {
      if (!path.isAbsolute(directory)) throw new LocalTrainingModelError("Choose an absolute checkpoint folder path.");
      let staged: string | undefined;
      try {
        const source = await realpath(directory);
        const { names } = await layout(source);
        await mkdir(root, { recursive: true, mode: 0o700 });
        staged = await mkdtemp(path.join(root, ".import-"));
        const modelDirectory = path.join(staged, "files");
        await mkdir(modelDirectory, { mode: 0o700 });
        const files = [];
        for (const name of names) files.push(await scanFile(source, name, signal, modelDirectory));
        const manifest = await buildManifest(modelDirectory, files);
        const id = contentHash(manifest);
        const label = path.basename(source).replace(/\p{Cc}/gu, " ").trim().slice(0, 240) || manifest.family;
        const record = { manifest, label };
        await writeFile(path.join(staged, "manifest.json"), JSON.stringify(record), { mode: 0o600, flush: true });
        signal?.throwIfAborted();
        try { await rename(staged, path.join(root, id)); staged = undefined; }
        catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          return (await verify(id, signal)).base;
        }
        return summarize(id, record);
      } catch (error) {
        if (error instanceof LocalTrainingModelError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new LocalTrainingModelError("Free disk space before importing the checkpoint.", 409);
        throw new LocalTrainingModelError("The checkpoint needs complete local safetensors, configuration, and tokenizer files.");
      } finally {
        if (staged) await rm(staged, { recursive: true, force: true });
      }
    },
  };
}
