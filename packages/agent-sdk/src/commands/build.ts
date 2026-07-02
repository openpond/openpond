import path from "node:path";

import { writeJson, writeText } from "../core/files";
import { loadAgentProject } from "../core/load-project";
import { assertArtifactSchemaCompatibility, writeArtifactIndex } from "../core/artifacts";
import {
  createActionRegistry,
  createAgentManifest,
  createInspect,
  createRuntimeBridge,
  createRuntimeManifest,
} from "../core/manifest";
import { compilePromptArtifacts } from "../core/prompts";
import { toYaml } from "../core/yaml";
import type { CliOptions } from "../core/types";
import { validateAgentProject, writeValidationReport } from "../core/validation";

export async function buildCommand(options: CliOptions) {
  const project = await loadAgentProject(options.cwd);
  const validation = validateAgentProject(project, options.cwd);
  if (validation.errors.length > 0) {
    await writeValidationReport(options.cwd, validation, options.outDir);
    throw new Error(`Build blocked by ${validation.errors.length} validation error(s).`);
  }

  const promptArtifacts = await compilePromptArtifacts(project, options.cwd, options.outDir);
  const manifest = createAgentManifest(project, promptArtifacts);
  const actionRegistry = createActionRegistry(project);
  const inspect = createInspect(project, options.cwd, options.outDir);

  await writeJson(options.cwd, path.join(options.outDir, "agent-manifest.json"), manifest);
  await writeJson(options.cwd, path.join(options.outDir, "action-registry.json"), actionRegistry);
  await writeJson(options.cwd, path.join(options.outDir, "agent-inspect.json"), inspect);
  await writeText(options.cwd, path.join(options.outDir, "openpond-manifest.preview.yaml"), `${toYaml(createRuntimeManifest(project))}\n`);
  await writeText(options.cwd, path.join(options.outDir, "runtime-bridge.mjs"), createRuntimeBridge(actionRegistry));
  await writeValidationReport(options.cwd, validation, options.outDir);
  const artifactIndex = await writeArtifactIndex(options.cwd, project, options.outDir, {
    promptArtifacts,
    mergeExisting: false,
  });
  await assertArtifactSchemaCompatibility(options.cwd, artifactIndex);

  if (options.json) {
    console.log(JSON.stringify({ manifest, actionRegistry, inspect, artifactIndex }, null, 2));
    return;
  }
  console.log(`Wrote ${options.outDir}/agent-manifest.json`);
  console.log(`Wrote ${options.outDir}/action-registry.json`);
  console.log(`Wrote ${options.outDir}/openpond-manifest.preview.yaml`);
  console.log(`Wrote ${options.outDir}/artifact-index.json`);
}
