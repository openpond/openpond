#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TasksetSchema } from "@openpond/contracts";
import {
  buildTaskset,
  canonicalJson,
  createTasksetDraft,
  inspectTaskset,
  readTasksetDraftPackage,
  validateTaskset,
  writeTasksetDraftPackage,
} from "./index.js";

async function main(): Promise<void> {
  const [command, source, destination] = process.argv.slice(2);
  if (!command || !source) throw new Error("Usage: openpond-taskset <init|import|export|build|inspect|validate|local-run> <source> [destination]");
  if (command === "init") {
    const directory = path.resolve(source);
    const name = path.basename(directory).replaceAll(/[-_]+/g, " ");
    const draft = createTasksetDraft({
      profileId: destination?.trim() || "default",
      name,
    });
    const result = await writeTasksetDraftPackage(draft, directory);
    process.stdout.write(JSON.stringify({ directory: result.directory, files: result.files, draftId: result.draft.id }, null, 2) + "\n");
    return;
  }
  if (command === "import") {
    if (!destination) throw new Error("import requires an output JSON path");
    const draft = await readTasksetDraftPackage(path.resolve(source));
    const output = path.resolve(destination);
    await writeFile(output, canonicalJson(draft), "utf8");
    process.stdout.write(JSON.stringify({ source: path.resolve(source), output, draftId: draft.id }, null, 2) + "\n");
    return;
  }
  if (command === "inspect") {
    const result = await inspectTaskset(path.resolve(source));
    process.stdout.write(JSON.stringify({ id: result.taskset.id, name: result.taskset.name, status: result.taskset.status, taskCount: result.taskset.tasks.length, graderCount: result.taskset.graders.length, report: result.report }, null, 2) + "\n");
    return;
  }
  const taskset = TasksetSchema.parse(JSON.parse(await readFile(path.resolve(source), "utf8")));
  if (command === "validate") {
    const report = validateTaskset(taskset);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.valid) process.exitCode = 1;
    return;
  }
  if (command === "build" || command === "export") {
    if (!destination) throw new Error(`${command} requires an output directory`);
    const result = await buildTaskset(taskset, path.resolve(destination));
    process.stdout.write(JSON.stringify({ directory: result.directory, files: result.files }, null, 2) + "\n");
    return;
  }
  if (command === "local-run") {
    const count = taskset.tasks.filter((task) => task.split === "validation").length;
    process.stdout.write(JSON.stringify({ tasksetId: taskset.id, split: "validation", runnableTasks: count, environment: taskset.environment }, null, 2) + "\n");
    return;
  }
  throw new Error(`Unknown command ${command}.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
