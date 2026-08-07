import { z } from "zod";

import { canonicalHash } from "./canonical.js";

export type AgentToolPlacement = "runtime" | "local" | "managed";

export type AgentToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  placement: AgentToolPlacement;
  displayLabel?: string;
  unavailableReason?: string | null;
  execute?: (input: TInput, context: AgentToolExecutionContext) => Promise<TOutput>;
};

export type AgentToolExecutionContext = {
  threadId: string;
  turnId: string;
  callId: string;
  signal: AbortSignal;
};

export type AgentToolCatalog = ReturnType<typeof createAgentToolCatalog>;

export function createAgentToolCatalog(definitions: readonly AgentToolDefinition[]) {
  const byName = new Map<string, AgentToolDefinition>();
  for (const definition of definitions) {
    const name = definition.name.trim();
    if (!name) throw new Error("Agent tool names cannot be empty.");
    if (byName.has(name)) throw new Error(`Duplicate agent tool: ${name}.`);
    if (!definition.unavailableReason && !definition.execute) {
      throw new Error(`Agent tool ${name} is declared as available without an executor.`);
    }
    byName.set(name, { ...definition, name });
  }
  const tools = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  const modelTools = tools
    .filter((tool) => !tool.unavailableReason)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7", unrepresentable: "any" })
    }));
  const capabilities = tools.map((tool) => ({
    name: tool.name,
    displayLabel: tool.displayLabel ?? tool.name,
    placement: tool.placement,
    available: !tool.unavailableReason,
    unavailableReason: tool.unavailableReason ?? null
  }));
  const hash = canonicalHash({ modelTools, capabilities });
  return { byName, tools, modelTools, capabilities, hash };
}

export async function executeAgentTool(
  catalog: AgentToolCatalog,
  input: { name: string; arguments: unknown; context: AgentToolExecutionContext },
): Promise<unknown> {
  const definition = catalog.byName.get(input.name);
  if (!definition) throw new Error(`Unknown agent tool: ${input.name}.`);
  if (definition.unavailableReason) {
    throw new Error(`Agent tool ${input.name} is unavailable: ${definition.unavailableReason}`);
  }
  if (!definition.execute) throw new Error(`Agent tool ${input.name} has no executor.`);
  return definition.execute(definition.inputSchema.parse(input.arguments), input.context);
}
