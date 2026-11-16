import type { ProviderSettings } from "@openpond/contracts/providers";
import type { SubagentToolHandlers } from "./facets.js";
import type { createSubagentMessagingRuntime } from "./messaging-runtime.js";
import { subagentModelCatalog } from "./model-selection.js";

/** Share the same model selection and lifecycle handlers across provider tools. */
export function createSubagentCapabilityHandlers(
  runtime: SubagentToolHandlers,
  loadProviderSettings: (() => Promise<ProviderSettings>) | undefined,
  sendSubagentMessage: ReturnType<typeof createSubagentMessagingRuntime>["sendSubagentMessageFromModelTool"],
) {
  return {
    listSubagentModels: async () => ({ models: subagentModelCatalog(await loadProviderSettings?.() ?? null) }),
    startSubagent: runtime.startSubagentFromModelTool,
    statusSubagents: runtime.statusSubagentsFromModelTool,
    joinSubagent: runtime.joinSubagentFromModelTool,
    cancelSubagent: runtime.cancelSubagentFromModelTool,
    followupSubagent: runtime.followupSubagentFromModelTool,
    sendSubagentMessage,
  };
}
