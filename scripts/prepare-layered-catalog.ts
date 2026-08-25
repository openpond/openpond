import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ManifestRow = {
  category: string;
  index: number;
  originalLayerName: string;
  file: string;
};

const options = parseOptions(process.argv.slice(2));
const manifest = await readManifest(path.join(options.source, "manifest.tsv"));
await mkdir(options.output, { recursive: true });

await mapConcurrent(manifest, 4, async (row) => {
  const destination = path.join(options.output, row.file);
  await mkdir(path.dirname(destination), { recursive: true });
  await execFileAsync("convert", [
    path.join(options.source, row.file),
    "-resize",
    `${options.size}x${options.size}`,
    destination,
  ]);
});

const byCategory = new Map<string, ManifestRow[]>();
for (const row of manifest) {
  const current = byCategory.get(row.category) ?? [];
  current.push(row);
  byCategory.set(row.category, current);
}
const orderedCategories = options.layerOrder.map((category) => {
  const rows = byCategory.get(category);
  if (!rows?.length) throw new Error(`Layer order references missing category ${category}.`);
  return { category, rows };
});
const catalog = {
  schemaVersion: "openpond.layeredArtifactCatalog.v1",
  width: options.size,
  height: options.size,
  layers: orderedCategories.map(({ category, rows }) => ({
    id: category,
    label: titleCase(category),
    variants: rows.map((row) => ({
      id: variantId(row),
      label: row.originalLayerName,
      file: row.file,
      rarityWeight: 1,
    })),
  })),
};
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["traits"],
  properties: {
    traits: {
      type: "object",
      additionalProperties: false,
      required: orderedCategories.map(({ category }) => category),
      properties: Object.fromEntries(orderedCategories.map(({ category, rows }) => [
        category,
        {
          type: "string",
          enum: rows.map(variantId),
        },
      ])),
    },
  },
};
const hostedRenderer = {
  kind: "reference_layered_artifact_v1",
  config: {
    schemaVersion: "openpond.referenceLayeredArtifact.v1",
    width: options.size,
    height: options.size,
    background: "transparent",
    layers: await Promise.all(orderedCategories.map(async ({ category, rows }) => ({
      id: category,
      variants: await Promise.all(rows.map(async (row) => ({
        id: variantId(row),
        pngDataUrl: `data:image/png;base64,${(await readFile(path.join(options.output, row.file))).toString("base64")}`,
        rarityWeight: 1,
      }))),
    }))),
  },
};

await Promise.all([
  writeJson(path.join(options.output, "catalog.json"), catalog),
  writeJson(path.join(options.output, "output-schema.json"), outputSchema),
  writeJson(path.join(options.output, "hosted-renderer.json"), hostedRenderer),
]);

const rendererBytes = Buffer.byteLength(JSON.stringify(hostedRenderer));
process.stdout.write(JSON.stringify({
  source: options.source,
  output: options.output,
  size: options.size,
  layers: catalog.layers.length,
  variants: manifest.length,
  hostedRendererBytes: rendererBytes,
}, null, 2) + "\n");

function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --key value arguments.");
    values.set(key.slice(2), value);
  }
  const source = path.resolve(required(values, "source"));
  const output = path.resolve(required(values, "output"));
  const size = Number(values.get("size") ?? "512");
  if (!Number.isInteger(size) || size < 64 || size > 2_048) throw new Error("size must be 64-2048.");
  return {
    source,
    output,
    size,
    layerOrder: required(values, "layer-order").split(",").map((value) => value.trim()).filter(Boolean),
  };
}

async function readManifest(file: string): Promise<ManifestRow[]> {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  const header = lines.shift()?.split("\t") ?? [];
  if (header.join("\t") !== "category\tindex\toriginal_layer_name\tfile") {
    throw new Error("Manifest columns must be category, index, original_layer_name, and file.");
  }
  return lines.map((line) => {
    const [category, index, originalLayerName, filePath] = line.split("\t");
    if (!category || !index || !originalLayerName || !filePath) throw new Error(`Invalid manifest row: ${line}`);
    return { category, index: Number(index), originalLayerName, file: filePath };
  });
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const value = values[index++];
      if (value !== undefined) await run(value);
    }
  }));
}

function variantId(row: ManifestRow): string {
  return `${row.category}-${String(row.index).padStart(3, "0")}`;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

function titleCase(value: string): string {
  return value.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
