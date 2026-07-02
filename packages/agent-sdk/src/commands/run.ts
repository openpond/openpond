import { loadAgentProject } from "../core/load-project";
import {
  assertArtifactSchemaCompatibility,
  traceEntry,
  writeArtifactIndex,
} from "../core/artifacts";
import { createRunState, executeAction, writeTrace } from "../core/runner";
import { normalizeInput } from "../core/schema";
import type { CliOptions } from "../core/types";

export async function runCommand(options: CliOptions) {
  if (!options.actionName) throw new Error("Usage: openpond-agent run <action>");
  const project = await loadAgentProject(options.cwd);
  const state = createRunState();
  const result = await executeAction(project, options.actionName, normalizeInput(options.input), state);
  const traceArtifactRef = await writeTrace(options.cwd, `run-${options.actionName}`, state, options.outDir);
  const artifactIndex = await writeArtifactIndex(options.cwd, project, options.outDir, {
    includeStandard: false,
    extraEntries: [traceEntry(traceArtifactRef)],
  });
  await assertArtifactSchemaCompatibility(options.cwd, {
    ...artifactIndex,
    entries: artifactIndex.entries.filter((entry) => entry.kind === "trace-jsonl"),
  });
  console.log(JSON.stringify({ result, traceArtifactRef }, null, 2));
}
