import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Catalog = {
  layers: Array<{
    id: string;
    variants: Array<{ id: string; file: string }>;
  }>;
};

const options = parseOptions(process.argv.slice(2));
const catalog = JSON.parse(
  await readFile(path.join(options.catalogDirectory, "catalog.json"), "utf8"),
) as Catalog;
const schemas = JSON.parse(
  await readFile(path.join(options.catalogDirectory, "output-schema.json"), "utf8"),
) as Record<string, unknown>;
const selections = createSelections(catalog, 8);

await mkdir(options.artifactDirectory, { recursive: true });
const candidates = await Promise.all(selections.map(async (traits, index) => {
  const output = JSON.stringify({ traits });
  const imagePath = path.join(options.artifactDirectory, `candidate-${index + 1}.png`);
  await renderLayeredSelection({
    catalog,
    catalogDirectory: options.catalogDirectory,
    traits,
    output: imagePath,
  });
  return {
    id: `fixture-candidate-${index + 1}`,
    output,
    imageDataUrl: `data:image/png;base64,${(await readFile(imagePath)).toString("base64")}`,
    label: index % 4 === 0 ? "love" : index % 4 === 1 ? "like" : "reject",
  };
}));

const request = {
  schemaVersion: "openpond.syntheticCollectionRun.v1",
  id: options.id,
  tasksetId: options.tasksetId,
  fixtureRelease: immutableRef("fixture", { catalog, schemas, selections }),
  labelerRelease: immutableRef("labeler", {
    protocol: "fixed_bucket_fixture_v1",
    labels: ["love", "like", "reject", "reject"],
  }),
  groups: [
    {
      scenarioId: options.trainScenarioId,
      partition: "reward_train",
      candidates: candidates.slice(0, 4),
    },
    {
      scenarioId: options.validationScenarioId,
      partition: "reward_validation",
      candidates: candidates.slice(4, 8),
    },
  ],
};

await writeFile(options.output, `${JSON.stringify(request, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({
  output: options.output,
  artifactDirectory: options.artifactDirectory,
  groups: request.groups.length,
  candidates: candidates.length,
}, null, 2) + "\n");

async function renderLayeredSelection(input: {
  catalog: Catalog;
  catalogDirectory: string;
  traits: Record<string, string>;
  output: string;
}): Promise<void> {
  const inputs = input.catalog.layers.map((layer) => {
    const variant = layer.variants.find((candidate) => candidate.id === input.traits[layer.id]);
    if (!variant) throw new Error(`Missing selected variant for ${layer.id}.`);
    return path.join(input.catalogDirectory, variant.file);
  });
  await execFileAsync("convert", [
    "-size", "512x512",
    "xc:none",
    ...inputs,
    "-background", "none",
    "-flatten",
    "+repage",
    input.output,
  ]);
}

function createSelections(catalog: Catalog, count: number): Array<Record<string, string>> {
  if (!catalog.layers.length || catalog.layers.some((layer) => !layer.variants.length)) {
    throw new Error("Catalog must contain at least one variant for every layer.");
  }
  const values = catalog.layers.map((layer) => layer.variants.map((variant) => variant.id));
  const total = values.reduce((product, variants) => product * variants.length, 1);
  if (total < count) throw new Error(`Catalog exposes only ${total} unique selections; ${count} are required.`);
  return Array.from({ length: count }, (_, index) => {
    let remaining = index;
    return Object.fromEntries(catalog.layers.map((layer, layerIndex) => {
      const variants = values[layerIndex]!;
      const variant = variants[remaining % variants.length]!;
      remaining = Math.floor(remaining / variants.length);
      return [layer.id, variant];
    }));
  });
}

function immutableRef(prefix: string, value: unknown) {
  return {
    id: `${prefix}-${hash(value).slice(0, 24)}`,
    contentHash: hash(value),
  };
}

function hash(value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --key value arguments.");
    values.set(key.slice(2), value);
  }
  const catalogDirectory = path.resolve(required(values, "catalog"));
  return {
    id: required(values, "id"),
    tasksetId: required(values, "taskset"),
    trainScenarioId: required(values, "train-scenario"),
    validationScenarioId: required(values, "validation-scenario"),
    catalogDirectory,
    artifactDirectory: path.resolve(values.get("artifacts") ?? path.join(catalogDirectory, "fixture-artifacts")),
    output: path.resolve(required(values, "output")),
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}
