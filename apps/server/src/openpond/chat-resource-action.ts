import type { ModelToolExecutionContext } from "./model-tool-registry.js";

export type ChatResourceAction = (context:ModelToolExecutionContext,kind:"dataset"|"experiment",payload:Record<string,unknown>)=>Promise<unknown>;
