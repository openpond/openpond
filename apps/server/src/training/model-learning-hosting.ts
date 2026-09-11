import { z } from "zod";
import { createModelProjectsClient } from "openpond-sdk/model-projects";
import { LearningCommandSchema, OpenPondLearningClient, learningRef, learningScheduleId, type LearningCommand } from "openpond-sdk/learning";
import type { SqliteStore } from "../store/store.js";
import { HostedLearningReviewRequestSchema, runHostedLearningReview } from "./model-learning-review.js";

const ScopeSchema = z.object({ modelId: z.string().min(1), profileId: z.string().min(1) });
type Scope = z.infer<typeof ScopeSchema>;

/** Hosted credentials stay in the server. Every operation retains the selected
 * local Profile, hosted workspace and portable Model identity. */
export function createModelLearningHostingService(input: {
  store: SqliteStore;
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
  fetch?: typeof fetch;
}) {
  async function scoped(value: Scope) {
    const scope = ScopeSchema.parse(value);
    const local = await input.store.getModelProject(scope.modelId);
    if (!local || local.profileId !== scope.profileId || !local.hosted) throw new Error("Select a hosted Model in this Profile to manage learning.");
    const access = await input.resolveAccess();
    if (local.hosted.teamId !== access.teamId || local.hosted.apiOrigin !== new URL(access.apiBaseUrl).origin) throw new Error("The Model's hosted workspace differs from the active connection.");
    const options = { baseUrl: access.apiBaseUrl, apiKey: access.token, scope: access.teamId, fetch: input.fetch };
    const client = new OpenPondLearningClient(options);
    const models = createModelProjectsClient({ baseUrl: access.apiBaseUrl, headers: { Authorization: `Bearer ${access.token}`, "X-OpenPond-Team-Id": access.teamId }, fetch: input.fetch });
    const { project } = await models.get(local.hosted.projectId);
    if (project.portableProjectId !== local.id || project.id !== local.hosted.projectId) throw new Error("The hosted Model identity differs from the selected Model.");
    return { client, project };
  }
  async function ownedPolicy(client: OpenPondLearningClient, modelId: string, id: string, revision?: number) {
    const policy = await client.get("policy", id, revision);
    if (policy.modelProjectId !== modelId || policy.executionOwner !== "hosted") throw new Error("The learning policy does not belong to this hosted Model.");
    return policy;
  }
  return {
    async taskQueue(value: Scope & { workspace: boolean }) {
      const { client, project } = await scoped(value);
      return client.inspectTaskQueue(value.workspace ? null : project.portableProjectId);
    },
    async review(value: Scope & { request: unknown }) {
      const request = HostedLearningReviewRequestSchema.parse(value.request);
      const { client, project } = await scoped(value);
      const policy = await ownedPolicy(client, project.portableProjectId, request.policyId);
      return runHostedLearningReview(client, policy, request.sourceId, request.endpoint, request.request);
    },
    async sources(value: Scope & { afterId?: string }) {
      const { client } = await scoped(value);
      const sources = await client.list("source", { limit: 30, ...(value.afterId ? { afterId: value.afterId } : {}) });
      const refs = [...new Map(sources.items.map(source => [JSON.stringify(source.taskDefinition), source.taskDefinition])).values()];
      const definitions = await Promise.all(refs.map(ref => client.get("definition", ref.id, ref.revision)));
      return { sources, definitions };
    },
    async overview(value: Scope & { policyId?: string; afterId?: string }) {
      const { client, project } = await scoped(value);
      const policies = await client.list("policy", { parentId: project.portableProjectId, limit: 30, ...(value.afterId ? { afterId: value.afterId } : {}) });
      if (policies.items.some(policy => policy.modelProjectId !== project.portableProjectId)) throw new Error("Learning policies differ from the selected Model.");
      const selectedId = value.policyId ?? (policies.items.length === 1 ? policies.items[0]!.id : null);
      if (!selectedId) return { project, policies, policy: null, inspection: null, schedule: null, iteration: null, dispatch: null };
      const policy = await ownedPolicy(client, project.portableProjectId, selectedId);
      const inspection = await client.inspectPolicy(learningRef(policy));
      const optional = async <T>(read: () => Promise<T>): Promise<T | null> => {
        try { return await read(); } catch (error) { if (error && typeof error === "object" && "status" in error && error.status === 404) return null; throw error; }
      };
      const schedule = ["schedule", "nightly", "approved_count"].includes(policy.trigger.kind) ? await optional(() => client.get("schedule", learningScheduleId(policy.id))) : null;
      const iteration = inspection.chain?.latestIterationId ? await client.get("iteration", inspection.chain.latestIterationId) : null;
      if (iteration) await ownedPolicy(client, project.portableProjectId, iteration.policy.id, iteration.policy.revision);
      const dispatch = iteration ? (await client.list("dispatch", { parentId: iteration.id, limit: 1 })).items[0] ?? null : null;
      return { project, policies, policy, inspection, schedule, iteration, dispatch };
    },
    async command(value: Scope & { command: LearningCommand }) {
      const command = LearningCommandSchema.parse(value.command);
      const { client, project } = await scoped(value);
      if (command.action === "publish" && command.kind === "policy") {
        if (command.content.modelProjectId !== project.portableProjectId || command.content.executionOwner !== "hosted") throw new Error("Learning settings must belong to this hosted Model.");
        if (command.expectedRevision > 0) await ownedPolicy(client, project.portableProjectId, command.content.id, command.expectedRevision);
      } else if (command.action === "reserve_iteration") {
        const policy = await ownedPolicy(client, project.portableProjectId, command.policy.id, command.policy.revision);
        if (policy.contentHash !== command.policy.contentHash) throw new Error("The selected policy revision changed.");
        if (command.trigger.kind !== "manual") throw new Error("Desktop can request only manual training; hosted timers own scheduled triggers.");
      } else if (command.action === "cancel_iteration" || command.action === "retry_iteration_dispatch") {
        const iteration = await client.get("iteration", command.iterationId);
        await ownedPolicy(client, project.portableProjectId, iteration.policy.id, iteration.policy.revision);
      } else throw new Error("Unsupported hosted Model learning operation.");
      return client.command(command);
    },
  };
}
