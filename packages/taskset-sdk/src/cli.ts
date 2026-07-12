#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TasksetSchema } from "@openpond/contracts";
import { buildTaskset, inspectTaskset, validateTaskset } from "./index.js";

async function main(): Promise<void> {
  const [command, source, destination] = process.argv.slice(2);
  if (!command || !source) throw new Error("Usage: openpond-taskset <build|inspect|validate|local-run> <taskset.json> [output-directory]");
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
  if (command === "build") {
    if (!destination) throw new Error("build requires an output directory");
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
