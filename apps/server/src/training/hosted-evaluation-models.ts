import { z } from "zod";
import { listOpChatModels } from "@openpond/cloud/hosted-chat";
import { ModelProjectBaseModelSchema } from "openpond-sdk/model-projects";

const HostedEvaluationModelListSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(500),
    display_name: z.string().max(500).optional(),
    endpoints: z.array(z.string()).optional(),
    capabilities: z.object({ samplingParameters: z.boolean().optional() }).passthrough().optional(),
    metadata: z.object({ baseModel: ModelProjectBaseModelSchema.optional() }).passthrough().optional(),
  }).passthrough()).max(200),
}).passthrough();

export async function readHostedEvaluationModels(access: { apiBaseUrl: string; token: string; teamId: string }) {
  const models = HostedEvaluationModelListSchema.parse(await listOpChatModels({
    apiBaseUrl: `${access.apiBaseUrl.replace(/\/+$/, "")}/v1`,
    token: access.token,
    teamId: access.teamId,
    signal: AbortSignal.timeout(15_000),
  }));
  return { models: models.data.filter(model => model.endpoints?.includes("chat.completions")).map(model => ({
    id: model.id,
    name: model.display_name ?? model.id,
    supportsSampling: model.capabilities?.samplingParameters === true,
    baseModel: model.metadata?.baseModel ?? null,
  })) };
}
