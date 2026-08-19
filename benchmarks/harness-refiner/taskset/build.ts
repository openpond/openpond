import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TasksetReleaseSchema,
  validateTasksetRelease,
  type TaskRecord,
  type TasksetRelease,
  type ToolDeclaration,
} from "@openpond/evals";
import {
  canonicalJson,
  contentHash,
  withContentHash,
  type ImmutableAssetRef,
} from "@openpond/harness";

import {
  createWebFetchModelToolDefinition,
  createWebSearchModelToolDefinition,
  type ModelToolDefinition,
} from "../../../apps/server/src/openpond/model-tool-registry.js";
import { createWorkModelToolDefinitions } from "../../../apps/server/src/openpond/work-tool-registry.js";
import { BENCHMARK_CASES } from "./cases.js";
import {
  deterministicContractFor,
  deterministicContractTaskIds,
} from "./deterministic-contracts.js";

const tasksetDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(tasksetDirectory, "taskset.release.json");
const releaseDirectory = path.join(tasksetDirectory, "releases");
const historicalReleasePath = path.join(
  releaseDirectory,
  "harness-refiner-08112026.json",
);
const versionedOutputPath = path.join(
  releaseDirectory,
  "harness-refiner-20260818-v2.json",
);
const builtinModulePath = path.resolve(
  tasksetDirectory,
  "../../../packages/evals/src/builtin-benchmarks/harness-refiner.ts",
);

const selectedWorkToolNames = new Set([
  "work_environment",
  "work_list_files",
  "work_read_file",
  "work_write_file",
  "work_edit_file",
  "work_exec",
  "work_save_output",
  "work_stop",
]);

const workDefinitions = createWorkModelToolDefinitions({
  executeWorkspaceTool: async () => {
    throw new Error("Taskset generation never executes Work tools.");
  },
}).filter((definition) => selectedWorkToolNames.has(definition.name));
const definitions = [
  ...workDefinitions,
  createWebSearchModelToolDefinition({
    executeWebSearch: async () => {
      throw new Error("Taskset generation never executes web search.");
    },
  }),
  createWebFetchModelToolDefinition(),
];

const readOnlyTools = new Set([
  "work_list_files",
  "work_read_file",
  "web_search",
  "web_fetch",
]);

function toolDeclaration(definition: ModelToolDefinition): ToolDeclaration {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
    inputSchemaHash: contentHash(definition.parameters),
    sideEffect: readOnlyTools.has(definition.name) ? "read" : "write",
    timeoutMs: definition.name === "work_exec" ? 300_000 : 120_000,
  };
}

async function assetRef(
  relativePath: string,
  visibility: ImmutableAssetRef["visibility"],
): Promise<ImmutableAssetRef> {
  const contents = await readFile(path.join(tasksetDirectory, relativePath), "utf8");
  return {
    id: relativePath.replaceAll(/[^a-zA-Z0-9_-]/g, "-"),
    path: relativePath,
    contentHash: contentHash(contents),
    sizeBytes: Buffer.byteLength(contents),
    mediaType: relativePath.endsWith(".mjs") ? "text/javascript" : "text/markdown",
    visibility,
  };
}

export async function buildTaskset(): Promise<TasksetRelease> {
  if (BENCHMARK_CASES.length !== 20) {
    throw new Error(`Expected 20 benchmark cases, found ${BENCHMARK_CASES.length}.`);
  }
  const ids = new Set(BENCHMARK_CASES.map((item) => item.id));
  const clusters = new Set(BENCHMARK_CASES.map((item) => item.clusterKey));
  if (ids.size !== BENCHMARK_CASES.length || clusters.size !== BENCHMARK_CASES.length) {
    throw new Error("Benchmark case ids and source clusters must be unique.");
  }
  if (
    contentHash([...ids].sort()) !== contentHash(deterministicContractTaskIds())
  ) {
    throw new Error("Every benchmark case must have exactly one deterministic contract.");
  }
  if (BENCHMARK_CASES.filter((item) => item.split === "validation").length !== 10) {
    throw new Error("The adaptation split must contain ten cases.");
  }
  if (BENCHMARK_CASES.filter((item) => item.split === "frozen_eval").length !== 10) {
    throw new Error("The frozen-evaluation split must contain ten cases.");
  }
  const expectedFamilyCounts = new Map([
    ["artifact-verification", 3],
    ["research-efficiency", 3],
    ["constraint-following", 4],
  ]);
  for (const split of ["validation", "frozen_eval"] as const) {
    for (const [family, expectedCount] of expectedFamilyCounts) {
      const actualCount = BENCHMARK_CASES.filter(
        (item) => item.split === split && item.tags.includes(family),
      ).length;
      if (actualCount !== expectedCount) {
        throw new Error(
          `Behavior family ${family} must contain ${expectedCount} ${split} cases; found ${actualCount}.`,
        );
      }
    }
  }

  const assetPaths = [
    ...new Set(BENCHMARK_CASES.flatMap((item) => item.attachmentPaths ?? [])),
  ];
  const assets = new Map(
    await Promise.all(
      assetPaths.map(async (relativePath) => [
        relativePath,
        await assetRef(relativePath, "policy"),
      ] as const),
    ),
  );
  const rubric = await assetRef("rubrics/task-quality.md", "verifier");
  const verifier = await assetRef(
    "verifiers/taskset-output-verifier.mjs",
    "verifier",
  );

  const tasks: TaskRecord[] = BENCHMARK_CASES.map((item) => ({
    id: item.id,
    clusterKey: item.clusterKey,
    split: item.split,
    input: {
      prompt: item.prompt,
      attachments: (item.attachmentPaths ?? []).map((relativePath) =>
        path.basename(relativePath),
      ),
    },
    expectedOutput: {
      ...item.expectedOutput,
      deterministicContract: deterministicContractFor(item.id),
    },
    policyVisibleContext: {
      attachmentCount: item.attachmentPaths?.length ?? 0,
    },
    privilegedContextRef: `expected-${item.id}`,
    artifactRefs: (item.attachmentPaths ?? []).map((relativePath) => {
      const asset = assets.get(relativePath);
      if (!asset) throw new Error(`Missing asset reference for ${relativePath}.`);
      return asset;
    }),
    requiredOutputs: releaseRequiredOutputs(
      item.id,
      item.expectedOutput.deliverable,
      item.expectedOutput.validation,
    ),
    tags: item.tags,
  }));

  const content = {
    schemaVersion: "openpond.tasksetRelease.v2" as const,
    id: "harness-refiner-20260818-v2",
    revision: 2,
    policy: {
      policyVisibleFields: ["input"],
      privilegedFields: ["expectedOutput"],
      hiddenGraderRefs: [rubric.id, verifier.id],
      connectedAppScopes: [],
    },
    environment: {
      protocolVersion: "openpond.environment.v1" as const,
      kind: "work" as const,
      entrypoint: "openpond-work-v1",
      stateful: true,
      deterministicSeeds: false,
      lifecycle: ["create", "reset", "step", "collect", "destroy"] as const,
      networkPolicy: "declared_read_only" as const,
      defaultTimeoutMs: 900_000,
    },
    tools: definitions.map(toolDeclaration),
    capabilities: [
      {
        id: "filesystem.workspace",
        required: true,
        scopes: ["inputs:read", "work:read-write", "outputs:write"],
        portability: "host_adapter" as const,
      },
      {
        id: "network.web-read",
        required: true,
        scopes: ["search", "fetch"],
        portability: "host_adapter" as const,
      },
      {
        id: "artifact.pdf",
        required: true,
        scopes: ["create", "render", "inspect"],
        portability: "host_adapter" as const,
      },
      {
        id: "artifact.spreadsheet",
        required: true,
        scopes: ["create", "calculate", "inspect"],
        portability: "host_adapter" as const,
      },
    ],
    tasks,
    graders: [
      {
        id: "task-output-contract",
        version: "1",
        kind: "custom_verifier" as const,
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        verifierRef: verifier,
        timeoutMs: 30_000,
        networkPolicy: "none" as const,
      },
    ],
    metadata: {
      benchmark: "harness-refiner",
      protocolVersion: "3",
      refinementMode: "sequential_product_lifecycle",
      adaptationSplit: "validation",
      frozenEvaluationSplit: "frozen_eval",
      primaryMetric: "paired_verified_reward",
      secondaryMetrics: ["paired_foreground_provider_tokens"],
      qualityPolicy: "complete_frozen_cohort",
      orderSeed: "harness-refiner-20260818-order-v1",
      resultSchemaVersion: "openpond.harnessRefinerPublicResult.v2",
      modelJudgeRole: "supplementary_uncalibrated_not_executed",
      supplementaryModelJudge: {
        id: "task-quality-judge",
        version: "1",
        rubricRef: rubric,
        calibrationStatus: "pending",
        executable: false,
        rewardEligible: false,
      },
      trainingSideEffect: false,
      toolDeclarationSource: "openpond-production-model-tool-definitions",
    },
  };

  const taskset = TasksetReleaseSchema.parse(withContentHash(content));
  const validation = validateTasksetRelease(taskset);
  if (!validation.valid) {
    throw new Error(
      `Generated Taskset failed validation: ${validation.issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return taskset;
}

export async function writeV2Taskset(): Promise<void> {
const taskset = await buildTaskset();
const serialized = canonicalJson(taskset);
const builtinAssets = Object.fromEntries(await Promise.all(
  [
    ...new Set(taskset.tasks.flatMap((task) => task.artifactRefs.map((asset) => asset.path))),
    ...taskset.graders.flatMap((grader) =>
      grader.kind === "model_judge"
        ? [grader.rubricRef.path]
        : grader.kind === "custom_verifier"
          ? [grader.verifierRef.path]
          : [],
    ),
    "rubrics/task-quality.md",
  ].sort().map(async (relativePath) => [
    relativePath,
    await readFile(path.join(tasksetDirectory, relativePath), "utf8"),
  ] as const),
));
const builtinModule = `// Generated by benchmarks/harness-refiner/taskset/build.ts. Do not edit.\n`
  + `import { TasksetReleaseSchema } from "../tasksets.js";\n\n`
  + `export const harnessRefinerBenchmarkRelease = TasksetReleaseSchema.parse(${serialized});\n\n`
  + `export const harnessRefinerBenchmarkAssets: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(builtinAssets, null, 2)});\n`;
if (process.argv.includes("--check")) {
  const checkedIn = await readFile(outputPath, "utf8");
  if (checkedIn !== serialized) {
    throw new Error(
      "The checked-in Taskset Release is stale. Run pnpm benchmark:harness-refiner:build.",
    );
  }
  const checkedInModule = await readFile(builtinModulePath, "utf8");
  if (checkedInModule !== builtinModule) {
    throw new Error(
      "The @openpond/evals built-in benchmark is stale. Run pnpm benchmark:harness-refiner:build.",
    );
  }
  const versioned = await readFile(versionedOutputPath, "utf8");
  if (versioned !== serialized) {
    throw new Error(
      "The versioned Taskset Release is stale. Run pnpm benchmark:harness-refiner:build.",
    );
  }
  const historical = JSON.parse(await readFile(historicalReleasePath, "utf8")) as {
    id?: unknown;
    contentHash?: unknown;
  };
  if (
    historical.id !== "harness-refiner-08112026"
    || historical.contentHash !== "4cef91a9c92df39d16f741b4d901dbde6b62e72bd8a48647a4a81c0d517d9634"
  ) {
    throw new Error("The historical Harness Refiner Taskset Release drifted.");
  }
} else {
  await mkdir(releaseDirectory, { recursive: true });
  try {
    await readFile(historicalReleasePath, "utf8");
  } catch {
    const current = await readFile(outputPath, "utf8");
    const historical = JSON.parse(current) as { id?: unknown; contentHash?: unknown };
    if (
      historical.id !== "harness-refiner-08112026"
      || historical.contentHash !== "4cef91a9c92df39d16f741b4d901dbde6b62e72bd8a48647a4a81c0d517d9634"
    ) {
      throw new Error("The checked-in historical Taskset cannot be archived safely.");
    }
    await writeFile(historicalReleasePath, current, "utf8");
  }
  await writeFile(outputPath, serialized, "utf8");
  await writeFile(versionedOutputPath, serialized, "utf8");
  await mkdir(path.dirname(builtinModulePath), { recursive: true });
  await writeFile(builtinModulePath, builtinModule, "utf8");
}
console.log(
  JSON.stringify({
    outputPath,
    id: taskset.id,
    contentHash: taskset.contentHash,
    tasks: taskset.tasks.length,
    tools: taskset.tools.length,
    checked: process.argv.includes("--check"),
  }),
);
}

if (isMainModule()) {
  await writeV2Taskset();
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint)
    && path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

function releaseRequiredOutputs(
  taskId: string,
  deliverable: BenchmarkCaseDeliverable,
  validationKinds: string[],
): TaskRecord["requiredOutputs"] {
  const output = deliverable === "pdf"
    ? { extension: "pdf", mediaType: "application/pdf" }
    : deliverable === "spreadsheet"
      ? {
          extension: "xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
      : null;
  if (!output) return [];
  return [{
    path: `${taskId}.${output.extension}`,
    mediaType: output.mediaType,
    schemaRef: null,
    maxBytes: 10_000_000,
    metadata: { validationKinds },
  }];
}

type BenchmarkCaseDeliverable = (typeof BENCHMARK_CASES)[number]["expectedOutput"]["deliverable"];
