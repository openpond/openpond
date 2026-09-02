import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  TasksetGraderDetailsResponseSchema,
  type Taskset,
  type TasksetGraderDetailsResponse,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";

export async function readTasksetGraderDetails(input: {
  store: SqliteStore;
  storeDir: string;
  tasksetId: string;
}): Promise<TasksetGraderDetailsResponse> {
  const taskset = await input.store.getTaskset(input.tasksetId);
  if (!taskset) throw new Error(`Taskset ${input.tasksetId} was not found.`);
  const sourceTasksetId = runtimeSourceTasksetId(taskset);
  const sources: TasksetGraderDetailsResponse["sources"] = [];
  const errors: string[] = [];
  let runtime: TasksetGraderDetailsResponse["runtime"] = null;
  let tasksetsRoot: string;
  let root: string;
  try {
    tasksetsRoot = await realpath(path.resolve(input.storeDir, "training", "tasksets"));
    root = await realpath(path.resolve(input.storeDir, "training", "tasksets", sourceTasksetId));
  } catch {
    return response(taskset, sourceTasksetId, null, [], "The Taskset package is not available on this device.");
  }
  if (!isWithin(tasksetsRoot, root)) {
    return response(taskset, sourceTasksetId, null, [], "The Taskset package resolves outside the user Taskset directory.");
  }

  const runtimePath = path.join(root, "graders", "managed-rl-runtime.json");
  const runtimeValue = await optionalJson(runtimePath);
  if (runtimeValue) {
    try {
      const config = record(runtimeValue);
      const module = requiredString(config.module, "Runtime grader module");
      const moduleSha256 = requiredString(config.moduleSha256, "Runtime grader module hash");
      runtime = {
        protocolVersion: requiredString(config.protocolVersion, "Runtime grader protocol"),
        module,
        moduleSha256,
        command: Array.isArray(config.command) ? config.command.map((value) => String(value)) : [],
        cwd: requiredString(config.cwd, "Runtime grader working directory"),
        maxTurns: typeof config.maxTurns === "number" ? config.maxTurns : 12,
      };
      sources.push(await readSource({ root, relativePath: module, graderId: rewardGraderId(taskset), declaredSha256: moduleSha256 }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const grader of taskset.graders) {
    if (grader.kind !== "custom_verifier") continue;
    if (sources.some((source) => source.path === grader.module)) continue;
    try {
      sources.push(await readSource({ root, relativePath: grader.module, graderId: grader.id, declaredSha256: null }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const unavailableReason = errors.length
    ? errors.join(" ")
    : sources.length
      ? null
      : "This Taskset does not declare a source-backed grader module.";
  return response(taskset, sourceTasksetId, runtime, sources, unavailableReason);
}

async function readSource(input: {
  root: string;
  relativePath: string;
  graderId: string | null;
  declaredSha256: string | null;
}): Promise<TasksetGraderDetailsResponse["sources"][number]> {
  const sourcePath = await realpath(path.resolve(input.root, input.relativePath));
  if (!isWithin(input.root, sourcePath)) {
    throw new Error(`Grader source ${input.relativePath} is outside the Taskset package.`);
  }
  const content = await readFile(sourcePath, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    graderId: input.graderId,
    path: path.relative(input.root, sourcePath),
    language: languageFor(sourcePath),
    content,
    sha256,
    declaredSha256: input.declaredSha256,
    integrity: input.declaredSha256 === null ? "unverified" : input.declaredSha256 === sha256 ? "verified" : "mismatch",
  };
}

function response(
  taskset: Taskset,
  sourceTasksetId: string,
  runtime: TasksetGraderDetailsResponse["runtime"],
  sources: TasksetGraderDetailsResponse["sources"],
  unavailableReason: string | null,
) {
  return TasksetGraderDetailsResponseSchema.parse({
    schemaVersion: "openpond.tasksetGraderDetails.v1",
    taskset: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash },
    sourceTasksetId,
    graders: taskset.graders,
    runtime,
    sources,
    unavailableReason,
  });
}

async function optionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function runtimeSourceTasksetId(taskset: Taskset): string {
  const imported = record(taskset.metadata.importedFromTaskset);
  const declared = typeof taskset.environment.metadata.runtimeSourceTasksetId === "string"
    ? taskset.environment.metadata.runtimeSourceTasksetId.trim()
    : "";
  const source = typeof imported.id === "string" ? imported.id.trim() : "";
  return declared || source || taskset.id;
}

function rewardGraderId(taskset: Taskset): string | null {
  return taskset.graders.find((grader) => grader.rewardEligible)?.id ?? taskset.graders[0]?.id ?? null;
}

function languageFor(filePath: string): "javascript" | "typescript" | "python" | "json" | "text" {
  const extension = path.extname(filePath).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if ([".ts", ".mts", ".cts", ".tsx"].includes(extension)) return "typescript";
  if (extension === ".py") return "python";
  if (extension === ".json") return "json";
  return "text";
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
  return value.trim();
}
