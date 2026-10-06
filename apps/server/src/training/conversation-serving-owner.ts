import { contentHash } from "@openpond/taskset-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqliteStore } from "../store/store.js";
import type { createTrainingService } from "./training-service.js";
import type { createModelProjectHostingService } from "./model-project-hosting.js";
import type { createManagedAdapterSyncService } from "./managed-adapter-sync-service.js";
import type { ManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { ConversationServingGrantSchema } from "./conversation-serving-contracts.js";
import { createConversationServingWorker } from "./conversation-serving-worker.js";

const id = z.string().trim().min(1).max(240);
const ScopeSchema = z.object({ profileId: id, modelId: id });
export function createConversationServingOwner(deps: {
  store: SqliteStore; training: ReturnType<typeof createTrainingService>;
  hosting: ReturnType<typeof createModelProjectHostingService>;
  synchronization: ReturnType<typeof createManagedAdapterSyncService>;
  registry: ManagedAdapterRegistryClient;
  resolveAccess(): Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
}) {
  async function request<T>(teamId: string, path: string, body?: unknown): Promise<T> {
    const access = await deps.resolveAccess();
    if (access.teamId !== teamId) throw new Error("Select the serving grant's authorized workspace.");
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("X-OpenPond-Team-Id", teamId); headers.set("content-type", "application/json");
    const response = await fetch(`${access.apiBaseUrl}/v1/connected-evidence/learning/${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(20000), method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as { code?: string };
    if (!response.ok) throw new Error(`Serving owner request failed (${response.status}): ${value.code ?? "request_failed"}`);
    return value as T;
  }
  async function scoped(raw: unknown) {
    const input = ScopeSchema.parse(raw), model = await deps.store.getModelProject(input.modelId);
    if (!model || model.profileId !== input.profileId || !model.hosted) throw new Error("Select a hosted Model in the serving Profile.");
    const access = await deps.resolveAccess();
    if (model.hosted.teamId !== access.teamId || model.hosted.apiOrigin !== new URL(access.apiBaseUrl).origin) throw new Error("The serving Model belongs to a different workspace.");
    return { model, access };
  }
  const worker = createConversationServingWorker({ ...deps, request });
  return {
    start: worker.start, close: worker.close, reconcile: worker.reconcile,
    async state(raw: unknown) {
      const { model, access } = await scoped(raw);
      const grants = (await deps.store.listConversationServingGrants()).filter(grant => grant.profileId === model.profileId && grant.hostedModelId === model.hosted!.projectId && grant.teamId === access.teamId);
      const bindings = (await deps.store.listModelBindings()).filter(binding => binding.profileId === model.profileId && binding.status === "active");
      const policies = await request<{ id: string; revision: number; status: string; configuration: { projectId: string; mode: string; configuration: { id: string } | null; serving?: { targetId: string } } }[]>(access.teamId, "policies");
      return { grants, bindings, policies: policies.filter(policy => policy.configuration.configuration?.id === model.hosted!.projectId).map(policy => ({ ...policy, servingAuthorized: grants.some(grant => grant.enabled && grant.authorizedConfigurationHash === contentHash(policy.configuration) && grant.id === policy.configuration.serving?.targetId) })), executions: (await Promise.all(grants.map(grant => deps.store.listConversationServingExecutions(grant.id)))).flat() };
    },
    async register(raw: unknown) {
      const input = ScopeSchema.extend({ projectId: id, bindingId: id }).strict().parse(raw);
      const { model, access } = await scoped(input);
      const binding = await deps.store.getModelBinding(input.bindingId);
      if (!binding || binding.status !== "active" || binding.profileId !== model.profileId) throw new Error("Select an active OpenPond binding in this Profile with a retained rollback target.");
      const grants = await deps.store.listConversationServingGrants();
      const prior = grants.find(grant => grant.teamId === access.teamId && grant.profileId === model.profileId && grant.role === binding.role && grant.roleTargetId === binding.roleTargetId && grant.projectId === input.projectId && grant.hostedModelId === model.hosted!.projectId && grant.enabled);
      if (prior) {
        await request(access.teamId, "serving-targets", { action: "register", targetId: prior.id, projectId: prior.projectId, ownerInstanceId: prior.ownerInstanceId, profileId: prior.profileId, role: prior.role, roleTargetId: prior.roleTargetId, expectedBindingId: prior.expectedBindingId });
        return prior;
      }
      const grant = ConversationServingGrantSchema.parse({ id: `conversation-serving-${randomUUID()}`, revision: 1, ownerInstanceId: `serving-owner-${randomUUID()}`, teamId: access.teamId, profileId: model.profileId, projectId: input.projectId, hostedModelId: model.hosted!.projectId, role: binding.role, roleTargetId: binding.roleTargetId, expectedBindingId: binding.id, policyId: null, authorizedConfigurationHash: null, enabled: true, updatedAt: new Date().toISOString() });
      // Save native intent first; registration recovers the same target identity.
      await deps.store.saveConversationServingGrant(grant, 0);
      await request(access.teamId, "serving-targets", { action: "register", targetId: grant.id, projectId: grant.projectId, ownerInstanceId: grant.ownerInstanceId, profileId: grant.profileId, role: grant.role, roleTargetId: grant.roleTargetId, expectedBindingId: grant.expectedBindingId });
      return grant;
    },
    async authorize(raw: unknown) {
      const input = ScopeSchema.extend({ grantId: id, policyId: id, expectedRevision: z.number().int().positive() }).strict().parse(raw);
      const { model, access } = await scoped(input);
      const prior = (await deps.store.listConversationServingGrants()).find(grant => grant.id === input.grantId && grant.enabled && grant.profileId === model.profileId && grant.hostedModelId === model.hosted!.projectId && grant.teamId === access.teamId);
      if (!prior) throw new Error("The native serving grant is unavailable.");
      const target = await request<{ authorizedConfigurationHash: string }>(access.teamId, "serving-targets", { action: "authorize", targetId: prior.id, ownerInstanceId: prior.ownerInstanceId, policyId: input.policyId, expectedRevision: input.expectedRevision });
      const grant = await deps.store.saveConversationServingGrant({ ...prior, revision: prior.revision + 1, policyId: input.policyId, authorizedConfigurationHash: z.string().length(64).parse(target.authorizedConfigurationHash), updatedAt: new Date().toISOString() }, prior.revision);
      await worker.reconcile();
      return grant;
    },
    async revoke(raw: unknown) {
      const input = ScopeSchema.extend({ grantId: id }).strict().parse(raw);
      const { model, access } = await scoped(input);
      const prior = (await deps.store.listConversationServingGrants()).find(grant => grant.id === input.grantId && grant.profileId === model.profileId && grant.hostedModelId === model.hosted!.projectId && grant.teamId === access.teamId);
      if (!prior) throw new Error("The native serving grant is unavailable.");
      const grant = await deps.store.saveConversationServingGrant({ ...prior, enabled: false, authorizedConfigurationHash: null, revision: prior.revision + 1, updatedAt: new Date().toISOString() }, prior.revision);
      await request(access.teamId, "serving-targets", { action: "revoke", targetId: grant.id, ownerInstanceId: grant.ownerInstanceId });
      await worker.reconcile();
      return grant;
    },
  };
}
export type ConversationServingOwner = ReturnType<typeof createConversationServingOwner>;
export type ConversationServingOwnerDependencies = Parameters<typeof createConversationServingOwner>[0];
export type ConversationServingOwnerRequest = <T>(teamId: string, path: string, body?: unknown) => Promise<T>;
