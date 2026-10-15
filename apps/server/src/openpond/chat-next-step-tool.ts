import type { ModelToolDefinition } from "./model-tool-registry.js";
import type { ChatResourceAction } from "./chat-resource-action.js";
import { nextStepSessionEligible } from "../training/chat-next-step.js";

export const CHAT_NEXT_STEP_INSTRUCTIONS = "When a useful next step exists for this chat's saved experiment or training resources, optionally call recommend_next_step before finishing your current turn. First omit action to inspect server-eligible choices, then nominate one returned action. The app validates readiness and supplies the exact editable draft. This never sends a message or authorizes execution. Do not call it for unrelated work or invent readiness. No additional model call is needed.";
export function createChatNextStepTool(execute: ChatResourceAction): ModelToolDefinition {
  return {
    name: "recommend_next_step",
    description: "Inspect eligible next-step drafts for this chat's saved resources, or nominate one eligible action for after this turn. Does not execute work or send a message.",
    parameters: {type:"object", properties:{action:{type:"string",enum:["prepare_evaluation","check_graders","inspect_results","diagnose","compare"]}},additionalProperties:false},
    enabled: context=>nextStepSessionEligible(context.session),
    execute: async context=>{
      if (!nextStepSessionEligible(context.session)) throw new Error("Next-step recommendations are unavailable in this session.");
      const result = await execute(context,"dataset",{action:"next_step",payload:{sessionId:context.session.id,operation:"recommend",action:context.args.action}});
      return {toolCallId:context.callId,name:"recommend_next_step",ok:true,contentText:JSON.stringify(result),data:result};
    },
  };
}
