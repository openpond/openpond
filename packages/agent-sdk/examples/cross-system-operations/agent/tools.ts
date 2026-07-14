import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  type CrossSystemToolName,
} from "@openpond/contracts";
import { defineTool, type AgentChatResult, type JsonSchema, type ToolDefinition } from "openpond-agent-sdk";

export function crossSystemInputSchemaName(name: CrossSystemToolName): string {
  return `${name}.input`;
}

export const crossSystemInputSchemas: Record<string, JsonSchema> = Object.fromEntries(
  CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => [
    crossSystemInputSchemaName(definition.name),
    definition.parameters,
  ]),
);

export const crossSystemTools: ToolDefinition[] = CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => defineTool({
  name: definition.name,
  description: `${definition.description} Contract ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}.`,
  visibility: "end_user",
  target: { kind: "action", action: definition.name },
  inputSchema: crossSystemInputSchemaName(definition.name),
  async run(ctx, input): Promise<AgentChatResult> {
    return ctx.tool(definition.name, async () => {
      ctx.trace.event("cross_system.tool_binding_required", {
        tool: definition.name,
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      });
      return {
        text: JSON.stringify({
          ok: false,
          code: "synthetic_environment_not_bound",
          tool: definition.name,
          toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
          suppliedContextKeys: Object.keys(input.context ?? {}).sort(),
          message: "Bind a generated Cross-System Operations Taskset attempt before executing this read-only tool.",
        }),
        intent: definition.name,
        metadata: { toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
      };
    });
  },
}));
