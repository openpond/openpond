import { z } from "zod";
import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";

const PlanSchema = z.object({
  explanation: z.string().max(4000).optional(),
  plan: z.array(z.object({ step: z.string().min(1).max(2000), status: z.enum(["pending", "in_progress", "completed"]) }).strict()).min(1).max(20),
}).strict();

/** Plans are ordinary durable harness tool results; ACP only projects their UI. */
export const acpPlanTool: ModelToolDefinition = {
  name: "update_plan",
  description: "Update the conversation's task plan. Include all steps and their current status. Use for multi-step work; this changes no workspace files.",
  parameters: z.toJSONSchema(PlanSchema, { target: "draft-7" }),
  execute: async context => {
    const data = PlanSchema.parse(context.args);
    return { toolCallId: context.callId, name: "update_plan", ok: true, contentText: JSON.stringify(data), data };
  },
};
