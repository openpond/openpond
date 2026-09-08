import { tasksetDraftFromTaskset } from "openpond-sdk/taskset-drafts";
export { tasksetDraftFromTaskset, publishTasksetDraft } from "openpond-sdk/taskset-drafts";
export { TasksetDraftPublishError, createTasksetDraft, type TasksetDraftPublishIssue } from "openpond-sdk/taskset-drafts";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  TasksetDraftSchema,
  type TasksetDraft,
} from "@openpond/contracts";

import { configuredTasksetDraftFiles, renderTasksetDraftManifests } from "openpond-sdk/taskset-drafts";

export async function writeTasksetDraftPackage(
  draftInput: unknown,
  directory: string,
): Promise<{ directory: string; files: string[]; draft: TasksetDraft }> {
  let draft = TasksetDraftSchema.parse(draftInput);
  const folders = [
    "tasks",
    "assets",
    "environment",
    "graders",
    "rubrics",
    "comparisons",
    "metrics",
    "fixtures",
  ];
  await Promise.all(folders.map((folder) => mkdir(path.join(directory, folder), { recursive: true })));
  const starterFiles = await writeConfiguredStarterCode(draft, directory);
  if (draft.metrics.customAggregator) {
    const aggregatorPath = path.join(directory, draft.metrics.customAggregator.module);
    const contentHash = createHash("sha256")
      .update(await readFile(aggregatorPath))
      .digest("hex");
    draft = TasksetDraftSchema.parse({
      ...draft,
      metrics: {
        ...draft.metrics,
        customAggregator: { ...draft.metrics.customAggregator, contentHash },
      },
    });
  }
  const manifestPath = path.join(directory, "taskset.json");
  const tasksPath = path.join(directory, "tasks", "tasks.jsonl");
  const gradersPath = path.join(directory, "graders", "graders.json");
  const fixturesPath = path.join(directory, "fixtures", "grader-fixtures.json");
  const metricsPath = path.join(directory, "metrics", "policy.json");
  const assetsPath = path.join(directory, "assets", "manifest.json");
  const environmentPath = path.join(directory, "environment", "contract.json");
  const reviewRubricPath = path.join(directory, "rubrics", "preference-review.md");
  const comparisonPath = path.join(directory, "comparisons", "policy.json");
  await Promise.all([...renderTasksetDraftManifests(draft)].map(([relative, content]) => writeFile(path.join(directory, relative), content, "utf8")));
  return {
    directory,
    files: [
      manifestPath,
      tasksPath,
      assetsPath,
      environmentPath,
      gradersPath,
      reviewRubricPath,
      comparisonPath,
      metricsPath,
      fixturesPath,
      ...starterFiles,
    ],
    draft,
  };
}

export async function hashTasksetDraftPackage(directory: string): Promise<string> {
  const files = await packageFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readTasksetDraftPackage(source: string): Promise<TasksetDraft> {
  const manifestPath = path.basename(source) === "taskset.json"
    ? source
    : path.join(source, "taskset.json");
  const directory = path.dirname(manifestPath);
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const draft = TasksetDraftSchema.safeParse(parsed);
  if (draft.success) {
    const [tasks, graders, fixtures, metrics, environment, review] = await Promise.all([
      readOptionalJsonLines(path.join(directory, "tasks", "tasks.jsonl")),
      readOptionalJson(path.join(directory, "graders", "graders.json")),
      readOptionalJson(path.join(directory, "fixtures", "grader-fixtures.json")),
      readOptionalJson(path.join(directory, "metrics", "policy.json")),
      readOptionalJson(path.join(directory, "environment", "contract.json")),
      readOptionalJson(path.join(directory, "comparisons", "policy.json")),
    ]);
    return TasksetDraftSchema.parse({
      ...draft.data,
      ...(tasks === null ? {} : { tasks }),
      ...(graders === null ? {} : { graders }),
      ...(fixtures === null ? {} : { graderFixtures: fixtures }),
      ...(metrics === null ? {} : { metrics }),
      ...(environment === null ? {} : { environment }),
      ...(review === null ? {} : { review }),
    });
  }
  return tasksetDraftFromTaskset(parsed);
}

async function writeConfiguredStarterCode(
  draft: TasksetDraft,
  directory: string,
): Promise<string[]> {
  const configured = configuredTasksetDraftFiles(draft);
  const written: string[] = [];
  for (const item of configured) {
    const file = path.join(directory, item.relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, item.source, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isFileExists(error)) throw error;
    }
    written.push(file);
  }
  return written;
}

async function packageFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Taskset workspaces cannot contain symbolic links: ${target}`);
      }
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(directory);
  return files;
}

async function readOptionalJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readOptionalJsonLines(file: string): Promise<unknown[] | null> {
  try {
    const content = await readFile(file, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
