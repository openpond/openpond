import { z } from "zod";
import type { ConversationServingOwnerDependencies, ConversationServingOwnerRequest } from "./conversation-serving-owner.js";
import { ConversationServingExecutionSchema, type ConversationServingExecution, type ConversationServingGrant } from "./conversation-serving-contracts.js";

const id = z.string().min(1).max(240);
const RequestSchema = z.object({ id, targetId: id, jobId: id, hostedModelId: id, artifactHash: z.string().length(64), registryArtifactId: id, registryArtifactHash: z.string().length(64), deploymentId: id, servingPoolId: id, authorizationHash: z.string().length(64), priorBindingId: id, leaseId: id.nullable(), bindingId: id.nullable(), activatedAt: z.string().datetime().nullable(), canarySeconds: z.number().int().min(30).max(600), status: z.enum(["queued", "claimed", "canary", "active", "rolled_back", "failed"]) }).passthrough();
const InspectionSchema = z.object({ request: RequestSchema, authorized: z.boolean() });
type Inspection = z.infer<typeof InspectionSchema>;

/** Pull work into the actual serving owner. Cloud receipts cannot replace a
 * native binding. Persist intent and discover the exact promotion after restart. */
export function createConversationServingWorker(deps: ConversationServingOwnerDependencies & { request: ConversationServingOwnerRequest }) {
  let active: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null, closed = false;
  async function save(value: ConversationServingExecution, changes: Partial<ConversationServingExecution>) {
    return deps.store.saveConversationServingExecution({ ...value, ...changes, revision: value.revision + 1, updatedAt: new Date().toISOString() }, value.revision);
  }
  async function inspect(grant: ConversationServingGrant, requestId: string) {
    return InspectionSchema.parse(await deps.request(grant.teamId, `serving-requests/${encodeURIComponent(requestId)}?ownerInstanceId=${encodeURIComponent(grant.ownerInstanceId)}`));
  }
  async function command(grant: ConversationServingGrant, execution: ConversationServingExecution, action: "renew" | "canary" | "complete" | "rollback" | "fail") {
    return RequestSchema.parse(await deps.request(grant.teamId, "serving-requests", { action, requestId: execution.id, targetId: grant.id, ownerInstanceId: grant.ownerInstanceId, leaseId: execution.leaseId, bindingId: execution.bindingId, restoredBindingId: execution.restoredBindingId, failure: execution.failure }));
  }
  async function updateExpectedBinding(grant: ConversationServingGrant, bindingId: string) {
    const current = (await deps.store.listConversationServingGrants()).find(value => value.id === grant.id);
    if (!current) throw new Error("The native serving grant disappeared.");
    if (current.expectedBindingId !== bindingId) await deps.store.saveConversationServingGrant({ ...current, expectedBindingId: bindingId, revision: current.revision + 1, updatedAt: new Date().toISOString() }, current.revision);
  }
  async function rollback(grant: ConversationServingGrant, execution: ConversationServingExecution, reason: string) {
    const binding = execution.bindingId ? await deps.store.getModelBinding(execution.bindingId) : (await deps.store.listModelBindings()).find(value => value.promotedBy === `conversation:${execution.id}`);
    if (!binding) {
      execution = await save(execution, { status: "failed", failure: reason });
      await command(grant, execution, "fail"); return;
    }
    const current = await deps.store.getActiveModelBinding({ profileId: grant.profileId, role: grant.role, roleTargetId: grant.roleTargetId });
    execution = await save(execution, { status: "rolling_back", bindingId: binding.id, failure: reason });
    if (current?.id === binding.id) {
      const restored = await deps.training.rollbackModelBinding({ bindingId: binding.id, rolledBackBy: `conversation:${execution.id}:rollback` });
      if (!restored.activeBinding) throw new Error("The authorized prior Model binding was not restored.");
      execution = await save(execution, { restoredBindingId: restored.activeBinding.id });
    } else {
      const restored = (await deps.store.listModelBindings()).find(value => value.status === "active" && value.promotedBy === `conversation:${execution.id}:rollback` && value.priorBindingId === binding.id);
      if (!restored) throw new Error("The serving target changed outside this operation; automatic rollback cannot replace another owner's choice.");
      execution = await save(execution, { restoredBindingId: restored.id });
    }
    await deps.synchronization.reconcile();
    await command(grant, execution, "rollback");
    execution = await save(execution, { status: "rolled_back" });
    await updateExpectedBinding(grant, execution.restoredBindingId!);
  }
  async function advance(grant: ConversationServingGrant, inspection: Inspection) {
    const request = inspection.request;
    let execution = (await deps.store.listConversationServingExecutions(grant.id)).find(value => value.id === request.id);
    if (!execution) {
      if (!grant.enabled || !inspection.authorized || grant.authorizedConfigurationHash !== request.authorizationHash || request.hostedModelId !== grant.hostedModelId || request.priorBindingId !== grant.expectedBindingId) throw new Error("The requested serving change differs from the exact native grant.");
      const claimed = RequestSchema.parse(await deps.request(grant.teamId, "serving-requests", { action: "claim", requestId: request.id, targetId: grant.id, ownerInstanceId: grant.ownerInstanceId, leaseId: null, bindingId: null, restoredBindingId: null, failure: null }));
      if (!claimed.leaseId) throw new Error("The serving owner did not receive a retained lease.");
      execution = await deps.store.saveConversationServingExecution(ConversationServingExecutionSchema.parse({ id: request.id, grantId: grant.id, revision: 1, jobId: request.jobId, artifactHash: request.artifactHash, priorBindingId: request.priorBindingId, bindingId: null, restoredBindingId: null, status: "prepared", leaseId: claimed.leaseId, canarySeconds: request.canarySeconds, activatedAt: null, failure: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), 0);
    }
    if (["superseded", "rolled_back", "failed"].includes(execution.status)) return;
    if (execution.status === "active") {
      if (!grant.enabled) return;
      const binding = execution.bindingId ? await deps.store.getModelBinding(execution.bindingId) : null;
      if (!binding || binding.status !== "active") { await save(execution, { status: "superseded" }); return; }
      const model = await deps.store.getModelArtifactLineage(binding.modelArtifactLineageId);
      const registry = await deps.registry.listRegistry(grant.teamId);
      const deployment = registry.deployments.find(value => value.id === model?.managedServing?.canonicalDeploymentId);
      if (!deployment || ["degraded", "failed", "deleted", "deleting"].includes(deployment.state)) await rollback(grant, execution, "The current candidate deployment failed runtime health after activation.");
      return;
    }
    if (request.status === "active") { await save(execution, { status: "active" }); await updateExpectedBinding(grant, request.bindingId!); return; }
    if (!grant.enabled || !inspection.authorized || execution.status === "rolling_back") return rollback(grant, execution, "Serving authority was revoked or the retained rollout requires rollback.");
    if (Date.now() - Date.parse(execution.createdAt) >= 1200000) return rollback(grant, execution, "The serving rollout exceeded its authorized reconciliation deadline.");
    await command(grant, execution, "renew");
    if (execution.status === "prepared" || execution.status === "binding") {
      await deps.hosting.pullProject({ hostedProjectId: grant.hostedModelId, profileId: grant.profileId });
      await deps.training.refreshManagedRunEvidence(execution.jobId);
      await deps.synchronization.reconcile();
      const existing = (await deps.store.listModelBindings()).find(value => value.promotedBy === `conversation:${execution!.id}`);
      if (existing) {
        if (existing.status !== "active" || existing.profileId !== grant.profileId || existing.role !== grant.role || existing.roleTargetId !== grant.roleTargetId) throw new Error("The retained serving promotion changed outside its owner.");
        execution = await save(execution, { status: "canary", bindingId: existing.id, activatedAt: existing.promotedAt });
      } else {
        const models = (await deps.store.listModelArtifactLineage()).filter(value => value.jobId === execution!.jobId && value.status === "imported");
        if (models.length !== 1) throw new Error("The exact hosted candidate is not imported into the serving owner.");
        if (models[0]!.managedServing?.canonicalArtifactId !== request.registryArtifactId || models[0]!.managedServing?.canonicalDeploymentId !== request.deploymentId) throw new Error("The candidate differs from the exact authorized serving deployment.");
        const artifact = await deps.store.getTrainingArtifact(models[0]!.artifactId);
        if (!artifact || artifact.sha256 !== execution.artifactHash) throw new Error("The serving candidate's immutable artifact changed.");
        const latest = (await deps.store.listConversationServingGrants()).find(value => value.id === grant.id);
        const authorized = await inspect(grant, execution.id);
        if (!latest?.enabled || latest.authorizedConfigurationHash !== request.authorizationHash || !authorized.authorized) return rollback(grant, execution, "Serving authority changed immediately before native activation.");
        execution = await save(execution, { status: "binding" });
        const binding = await deps.training.bindModel({ profileId: grant.profileId, modelId: models[0]!.id, role: grant.role, roleTargetId: grant.roleTargetId, promotedBy: `conversation:${execution.id}`, expectedActiveBindingId: execution.priorBindingId, servingGrant: { id: latest.id, expectedRevision: latest.revision, authorizationHash: request.authorizationHash } });
        execution = await save(execution, { status: "canary", bindingId: binding.id, activatedAt: binding.promotedAt });
      }
    }
    await deps.synchronization.reconcile();
    const binding = await deps.store.getModelBinding(execution.bindingId!);
    const model = binding ? await deps.store.getModelArtifactLineage(binding.modelArtifactLineageId) : null;
    if (!binding || binding.status !== "active" || !model?.managedServing) return rollback(grant, execution, "The active binding lost its verified serving projection.");
    const registry = await deps.registry.listRegistry(grant.teamId);
    const deployment = registry.deployments.find(value => value.id === model.managedServing!.canonicalDeploymentId);
    if (!deployment || ["degraded", "failed", "deleted", "deleting"].includes(deployment.state)) return rollback(grant, execution, "The candidate deployment failed the runtime canary.");
    if (deployment.state !== "ready") return;
    const canary = await command(grant, execution, "canary");
    if (Date.now() - Date.parse(canary.activatedAt!) >= execution.canarySeconds * 1000) {
      await command(grant, execution, "complete");
      await save(execution, { status: "active" });
      await updateExpectedBinding(grant, execution.bindingId!);
    }
  }
  async function once() {
    for (const grant of await deps.store.listConversationServingGrants()) {
      try {
        if (grant.enabled) await deps.request(grant.teamId, "serving-targets", { action: "heartbeat", targetId: grant.id, ownerInstanceId: grant.ownerInstanceId });
        const retained = (await deps.store.listConversationServingExecutions(grant.id)).filter(value => !["superseded", "rolled_back", "failed"].includes(value.status));
        for (const execution of retained) await advance(grant, await inspect(grant, execution.id));
        if (!grant.enabled || !grant.authorizedConfigurationHash) continue;
        const page = z.object({ requests: z.array(InspectionSchema) }).parse(await deps.request(grant.teamId, `serving-requests?targetId=${encodeURIComponent(grant.id)}&ownerInstanceId=${encodeURIComponent(grant.ownerInstanceId)}`));
        for (const inspection of page.requests) if (!retained.some(value => value.id === inspection.request.id)) await advance(grant, inspection);
      } catch (error) {
        // Retain actionable recovery state; never create another binding or job
        // after a lost response. The next sweep discovers the same operation.
        const retained = (await deps.store.listConversationServingExecutions(grant.id)).filter(value => !["active", "superseded", "rolled_back", "failed"].includes(value.status));
        for (const execution of retained) await save(execution, { failure: error instanceof Error ? error.message.slice(0, 2000) : "Serving reconciliation failed." });
      }
    }
  }
  function reconcile() { if (!active) active = once().finally(() => { active = null; }); return active; }
  function start() {
    if (closed || timer || active) return;
    const tick = () => { timer = null; void reconcile().finally(() => { if (!closed) { timer = setTimeout(tick, 10000); timer.unref?.(); } }); };
    tick();
  }
  async function close() { closed = true; if (timer) clearTimeout(timer); timer = null; await active; }
  return { start, close, reconcile };
}
