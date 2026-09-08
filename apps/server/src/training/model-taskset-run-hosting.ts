import { z } from "zod";
import { OpenPondModelTasksetRunsClient } from "openpond-sdk/model-taskset-runs";
import type { SqliteStore } from "../store/store.js";

const ScopeSchema = z.object({ modelId: z.string().min(1), profileId: z.string().min(1) });
type Scope = z.infer<typeof ScopeSchema>;
export function createModelTasksetRunHostingService(input: {
  store: SqliteStore;
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
  fetch?: typeof fetch;
}) {
  async function scoped(value: Scope) {
    const scope = ScopeSchema.parse(value);
    const project = await input.store.getModelProject(scope.modelId);
    if (!project || project.profileId !== scope.profileId || !project.hosted) throw new Error("Select a hosted Model in this Profile to read its evaluations.");
    const access = await input.resolveAccess();
    if (project.hosted.teamId !== access.teamId || project.hosted.apiOrigin !== new URL(access.apiBaseUrl).origin) throw new Error("The Model's hosted workspace differs from the active connection.");
    return { projectId: project.hosted.projectId, client: new OpenPondModelTasksetRunsClient({ baseUrl: access.apiBaseUrl, apiKey: access.token, teamId: access.teamId, fetch: input.fetch }) };
  }
  async function owned(value: Scope & { runId: string }) {
    const { client, projectId } = await scoped(value);
    const details = await client.get(value.runId);
    if (details.summary.modelProjectId !== projectId) throw new Error("The evaluation belongs to another Model.");
    return { client, projectId, details };
  }
  return {
    async list(value: Scope & { afterId?: string; limit?: number }) {
      const { client, projectId } = await scoped(value);
      return client.list({ modelProjectId: projectId, afterId: value.afterId, limit: value.limit });
    },
    async get(value: Scope & { runId: string }) { return (await owned(value)).details; },
    async cancel(value: Scope & { runId: string }) {
      const { client, projectId } = await owned(value);
      const result = await client.cancel(value.runId);
      if (result.summary.modelProjectId !== projectId) throw new Error("Cancelled evaluation differs from the selected Model.");
      return result;
    },
    async result(value: Scope & { runId: string }) {
      const { client, projectId } = await owned(value);
      const result = await client.result(value.runId);
      if (result.run.summary.modelProjectId !== projectId) throw new Error("Evaluation result differs from the selected Model.");
      return result;
    },
  };
}
