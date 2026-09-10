import { z } from "zod";
import { HostedModelProjectSummarySchema } from "openpond-sdk/model-projects";
import { OpenPondLearningClient, LearningSourceSchema, TaskDefinitionSchema, LearningPolicySchema, LearningPolicyInspectionResultSchema, LearningScheduleSchema,
  LearningIterationSchema, LearningIterationDispatchSchema, LearningOperationResultSchema, type LearningCommand } from "openpond-sdk/learning";
import { api, type ClientConnection } from "../api";
import { connectionQueryScope, scopeLearningClient } from "../lib/query-scope";

const OverviewSchema = z.object({
  project: HostedModelProjectSummarySchema,
  policies: z.object({ items: z.array(LearningPolicySchema), nextCursor: z.string().nullable() }),
  policy: LearningPolicySchema.nullable(), inspection: LearningPolicyInspectionResultSchema.nullable(),
  schedule: LearningScheduleSchema.nullable(), iteration: LearningIterationSchema.nullable(), dispatch: LearningIterationDispatchSchema.nullable(),
});
const SourcesSchema = z.object({ sources: z.object({ items: z.array(LearningSourceSchema), nextCursor: z.string().nullable() }), definitions: z.array(TaskDefinitionSchema) });
export type HostedModelLearningSources = z.infer<typeof SourcesSchema>;
export type HostedModelLearningOverview = z.infer<typeof OverviewSchema>;
export function createHostedModelLearningApi(connection: ClientConnection, modelId: string, profileId: string) {
  const path = `/models/${encodeURIComponent(modelId)}/hosted-learning`;
  return {
    reviewClient(policyId: string, sourceId: string) {
      return scopeLearningClient(new OpenPondLearningClient({ baseUrl: connection.serverUrl, apiKey: connection.token, scope: profileId, fetch: async (url, init) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1);
        if (endpoint !== "read" && endpoint !== "commands") throw new Error("Unsupported hosted review operation.");
        return fetch(`${connection.serverUrl}/v1/training${path}/review?${new URLSearchParams({ profileId })}`, {
          ...init, body: JSON.stringify({ policyId, sourceId, endpoint, request: JSON.parse(String(init?.body)) }),
        });
      } }), ["learning", connectionQueryScope(connection), profileId, "hosted", modelId, policyId, sourceId]);
    },
    async sources(afterId?: string) {
      return SourcesSchema.parse(await api.trainingRequest<unknown>(connection, `${path}/sources?${new URLSearchParams({ profileId, ...(afterId ? { afterId } : {}) })}`, undefined, "GET"));
    },
    async overview(query: { policyId?: string; afterId?: string } = {}) {
      const params = new URLSearchParams({ profileId, ...(query.policyId ? { policyId: query.policyId } : {}), ...(query.afterId ? { afterId: query.afterId } : {}) });
      return OverviewSchema.parse(await api.trainingRequest<unknown>(connection, `${path}?${params}`, undefined, "GET"));
    },
    async command(command: LearningCommand) {
      return LearningOperationResultSchema.parse(await api.trainingRequest<unknown>(connection, `${path}?${new URLSearchParams({ profileId })}`, command));
    },
  };
}
