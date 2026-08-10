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

const tasksetDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(tasksetDirectory, "taskset.release.json");
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
    expectedOutput: item.expectedOutput,
    policyVisibleContext: {
      attachmentCount: item.attachmentPaths?.length ?? 0,
    },
    privilegedContextRef: `expected-${item.id}`,
    artifactRefs: (item.attachmentPaths ?? []).map((relativePath) => {
      const asset = assets.get(relativePath);
      if (!asset) throw new Error(`Missing asset reference for ${relativePath}.`);
      return asset;
    }),
    tags: item.tags,
  }));

  const content = {
    schemaVersion: "openpond.tasksetRelease.v2" as const,
    id: "harness-refiner-public-v1",
    revision: 3,
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
      {
        id: "task-quality-judge",
        version: "1",
        kind: "model_judge" as const,
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        rubricRef: rubric,
        calibrationStatus: "pending" as const,
      },
    ],
    metadata: {
      benchmark: "harness-refiner",
      protocolVersion: "1",
      adaptationSplit: "validation",
      frozenEvaluationSplit: "frozen_eval",
      primaryMetric: "paired_foreground_provider_tokens",
      qualityPolicy: "hard_non_regression",
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
} else {
  await writeFile(outputPath, serialized, "utf8");
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
