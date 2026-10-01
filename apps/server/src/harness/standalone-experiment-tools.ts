import { contentHash, type ToolDeclaration } from "@openpond/harness";
import { STANDALONE_EXPERIMENT_READ_TOOLS, standaloneHarnessExperimentTools } from "@openpond/evals/experiments";
import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";

export const standaloneExperimentToolDeclarations = standaloneHarnessExperimentTools;

export function isolateStandaloneExperimentTools(
  tools: ModelToolDefinition[], declarations: readonly ToolDeclaration[],
): ModelToolDefinition[] {
  const available = new Map(tools.map(tool => [tool.name, tool]));
  return declarations.map(declaration => {
    const tool = available.get(declaration.name);
    if (!STANDALONE_EXPERIMENT_READ_TOOLS.has(declaration.name) || declaration.sideEffect !== "read"
      || !tool || contentHash(tool.parameters) !== declaration.inputSchemaHash) {
      throw new Error(`Standalone Harness tool has no compatible case-scoped implementation: ${declaration.name}.`);
    }
    return tool;
  });
}
