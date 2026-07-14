import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
} from "@openpond/contracts";
import { defineTool, type AgentChatResult, type ToolDefinition } from "openpond-agent-sdk";

export const crossSystemTools: ToolDefinition[] = CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => defineTool({
  name: definition.name,
  description: `${definition.description} Contract ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}.`,
  visibility: "end_user",
  target: { kind: "action", action: definition.name },
  inputSchema: definition.parameters,
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
