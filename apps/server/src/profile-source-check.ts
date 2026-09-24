import { promises as fs } from "node:fs";
import path from "node:path";

import { loadProfileSkills } from "@openpond/cloud/profile/profile-skills";
import { validateProfileEvaluationCatalog, ProfileEvaluationDefinitionSchema, ProfileEvaluationSuiteSchema } from "@openpond/evals";
import { compileProfileWorkflowPackages, validateProfileWorkflowCatalog } from "@openpond/harness";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";

async function sourceFiles(root: string, relativeDirectory: string): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Profile source directory is not a regular directory: ${relativeDirectory}`);
  }
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Profile source contains a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Profile source contains a non-regular file: ${relative}`);
  }
  return files.sort();
}

/** Check the authored components without building, committing, or running them. */
export async function checkLocalProfileSource(sourcePath: string, actionIds: ReadonlySet<string> = new Set()): Promise<{
  workflows: number;
  skills: number;
  evaluations: number;
  tasksets: number;
}> {
  const { skills, skillCatalog } = await loadProfileSkills(sourcePath);
  if (skillCatalog.error) throw new Error(`Profile Skills: ${skillCatalog.error}`);
  for (const skill of skills) {
    if (skill.validationStatus !== "valid") {
      throw new Error(`Profile Skill ${skill.name}: ${skill.validationMessages.join(" ")}`);
    }
  }
  const skillPaths = new Set(skills.map((skill) => skill.path));
  const files = [...await sourceFiles(sourcePath, "workflows"), ...await sourceFiles(sourcePath, "evals")].sort();
  const workflowFiles = files.filter((file) => file.startsWith("workflows/"));
  const hasPackages = workflowFiles.some((file) => /^workflows\/[^/]+\/(PROMPT\.md|ACTION\.json)$/.test(file));
  const legacyCatalog = workflowFiles.includes("workflows/catalog.json");
  if (hasPackages && legacyCatalog) throw new Error("Workflow packages and legacy workflows/catalog.json cannot coexist.");
  const catalog = hasPackages
    ? compileProfileWorkflowPackages({
        files: new Map(await Promise.all(workflowFiles.map(async (file) => [file, await fs.readFile(path.join(sourcePath, file), "utf8")] as const))),
        skillPaths,
        actionIds,
      }).catalog
    : legacyCatalog
      ? validateProfileWorkflowCatalog({
          catalog: JSON.parse(await fs.readFile(path.join(sourcePath, "workflows/catalog.json"), "utf8")),
          sourcePaths: skillPaths,
          actionIds,
        })
      : { workflows: [] };
  const workflowIds = new Set(catalog.workflows.map((workflow) => workflow.id));
  const definitionFiles = files.filter((file) => /^workflows\/[^/]+\/evals\/[^/]+\.json$/.test(file)
    || /^evals\/definitions\/[^/]+\.json$/.test(file));
  const suiteFiles = files.filter((file) => /^evals\/suites\/[^/]+\.json$/.test(file));
  if (files.includes("evals/catalog.json") && (definitionFiles.length || suiteFiles.length)) {
    throw new Error("Evaluation packages and legacy evals/catalog.json cannot coexist.");
  }
  const definitions = await Promise.all(definitionFiles.map(async (file) => {
    const value = ProfileEvaluationDefinitionSchema.parse(JSON.parse(await fs.readFile(path.join(sourcePath, file), "utf8")));
    const owner = /^workflows\/([^/]+)\/evals\//.exec(file)?.[1];
    if (owner && (value.target.kind !== "workflow" || value.target.workflowId !== owner)) {
      throw new Error(`Evaluation ${value.id} must target its containing Workflow ${owner}.`);
    }
    return value;
  }));
  const suites = await Promise.all(suiteFiles.map(async (file) =>
    ProfileEvaluationSuiteSchema.parse(JSON.parse(await fs.readFile(path.join(sourcePath, file), "utf8")))));
  const evaluationCatalog = files.includes("evals/catalog.json")
    ? JSON.parse(await fs.readFile(path.join(sourcePath, "evals/catalog.json"), "utf8"))
    : { schemaVersion: "openpond.profileEvaluations.v1", definitions, suites };
  const validated = validateProfileEvaluationCatalog({
    catalog: evaluationCatalog, workflowIds, skillPaths, actionIds,
  }).catalog;
  const tasksetFiles = files.filter((file) => /^evals\/tasksets\/[^/]+\.json$/.test(file));
  const tasksets = new Map<string, ReturnType<typeof validateTasksetPackage>["taskset"]>();
  for (const file of tasksetFiles) {
    const taskset = validateTasksetPackage(JSON.parse(await fs.readFile(path.join(sourcePath, file), "utf8"))).taskset;
    if (file !== `evals/tasksets/${taskset.contentHash}.json`) {
      throw new Error(`Frozen Taskset file name differs from its content hash: ${file}.`);
    }
    tasksets.set(taskset.contentHash, taskset);
  }
  for (const definition of validated.definitions) {
    const hash = definition.tasksetRelease.contentHash;
    const packagePath = `evals/tasksets/${hash}.json`;
    const taskset = tasksets.get(hash);
    if (!taskset) throw new Error(`Evaluation ${definition.id} is missing Taskset ${packagePath}.`);
    if (taskset.id !== definition.tasksetRelease.id || taskset.contentHash !== hash) {
      throw new Error(`Evaluation ${definition.id} references a different frozen Taskset.`);
    }
    const taskIds = new Set(taskset.tasks.filter((task) => task.split === definition.split).map((task) => task.id));
    for (const taskId of definition.taskIds) {
      if (!taskIds.has(taskId)) throw new Error(`Evaluation ${definition.id} references missing Taskset case ${taskId} in split ${definition.split}.`);
    }
  }
  return { workflows: catalog.workflows.length, skills: skills.length,
    evaluations: validated.definitions.length, tasksets: tasksets.size };
}
