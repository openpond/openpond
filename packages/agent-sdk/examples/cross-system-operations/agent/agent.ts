import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
} from "@openpond/contracts";
import {
  action,
  defineAgentProject,
  defineInstructions,
  editable,
} from "openpond-agent-sdk";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEval } from "openpond-agent-sdk/eval";
import { crossSystemTools } from "./tools";

const toolsByName = new Map(crossSystemTools.map((tool) => [tool.name, tool]));

export default defineAgentProject({
  name: "Cross-System Operations",
  version: "1.0.0",
  useCase: "cross-system-operations",
  description: "Reconcile exact operational answers across bounded synthetic CRM, billing, and support systems.",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace", networkPolicy: "none", toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
  model: { provider: "openpond-managed", required: true, temperature: 0, maxOutputTokens: 1_024 },
  instructions: defineInstructions("./agent/instructions.md"),
  defaultAction: "chat",
  actions: [
    action("chat", {
      target: { kind: "chat", instructions: "./agent/instructions.md", allowedActions: [...CROSS_SYSTEM_TOOL_DEFINITIONS.map((tool) => tool.name)] },
      description: "Use the normal frontier model and the four registered synthetic tools.",
    }),
    ...CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => action(definition.name, {
      label: definition.name,
      description: definition.description,
      visibility: "end_user",
      target: { kind: "tool", tool: toolsByName.get(definition.name)! },
      inputSchema: definition.parameters,
      approval: { mode: "never", reason: "Read-only synthetic data with no network or production credentials." },
    })),
  ],
  tools: crossSystemTools,
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text, metadata: result.metadata }),
    }),
  ],
  editable: editable({
    enabled: true,
    backend: "openpond-coding-work-item",
    runtimeEnvironmentId: "openpond-coding-core-v1",
    sourceOfTruth: "agent-source",
    policyDiscovery: { command: "openpond agent inspect --json", runAfter: "source-materialized" },
    allowedPaths: ["agent/**", "package.json", "README.md"],
    requiredChecks: ["openpond-agent validate", "openpond-agent eval"],
    defaultResultMode: "patch_only",
  }),
  evals: [
    defineEval({
      name: "contract-and-binding-gate",
      description: "The project exposes the shared contract and refuses unbound synthetic execution.",
      publishGate: true,
      async run(t) {
        await t.runAction("search_crm", { prompt: "contract probe", context: { arguments: { query: "*", fields: ["account_id"], cursor: null, limit: 1 } } });
        t.expectIntent("search_crm");
        t.expectTextIncludes(CROSS_SYSTEM_TOOL_CONTRACT_HASH);
        t.expectTraceEvent("cross_system.tool_binding_required");
      },
    }),
  ],
});
