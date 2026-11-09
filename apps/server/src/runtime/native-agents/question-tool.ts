import type { RuntimeEvent } from "@openpond/contracts/runtime";
import { createAuthoringModelToolDefinitions } from "../../openpond/authoring-tool-registry.js";
import type { ModelToolDefinition } from "../../openpond/model-tool-registry.js";
import { persistUserQuestion } from "../turns/persist-user-question.js";

export const NATIVE_QUESTION_INSTRUCTIONS = "Use ask_user for a necessary user choice or a concrete total-spend approval. It saves a question in this chat. Keep the form brief and explain the actual choice in plain language; its reason should not contain local paths or internal instruction quotations. A missing budget is a run input under the user's training request, not a separate skill-activation permission. After calling it, end this model round without further work; the app automatically continues the same task when the user answers. Ask only for information not already supplied. A skipped question is not approval; never start paid work while waiting or interpret an unrelated answer as approval.";

/** Native providers use the existing persisted question/answer owner. Ending
 * the provider round cannot strand a form whose answer requires a live RPC. */
export function createNativeQuestionTool(append: (event: RuntimeEvent) => Promise<void>): ModelToolDefinition {
  const base = createAuthoringModelToolDefinitions({}).find(tool => tool.name === "ask_user")!;
  const properties = { ...base.parameters.properties as Record<string, unknown> };
  delete properties.allowFreeform;
  return { ...base, parameters: { ...base.parameters, properties }, execute: async context => {
    context.signal.throwIfAborted();
    const result = await base.execute({ ...context, args: { ...context.args, allowFreeform: true } });
    context.signal.throwIfAborted();
    await persistUserQuestion(result, context.session, context.turnId, append);
    return result;
  } };
}
