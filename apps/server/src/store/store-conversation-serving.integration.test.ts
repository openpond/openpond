import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { ModelBindingSchema } from "@openpond/contracts";
import { SqliteStore } from "./store.js";
import { ConversationServingGrantSchema, ConversationServingExecutionSchema } from "../training/conversation-serving-contracts.js";

// Failure story: a delayed rollout must not commit after native consent is
// revoked, replace a concurrent manual choice, or lose its immutable recovery
// identity after restart. Both replicas use real SQLite; no provider is mocked.
// Binding fixtures exercise persistence, not artifact/acceptance qualification.
it("fences serving revocation and concurrent binding commits while retaining recovery after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpond-serving-boundary-"));
  let first = new SqliteStore(directory), second: SqliteStore | null = null;
  const time = new Date().toISOString(), hash = "a".repeat(64);
  try {
    const original = ModelBindingSchema.parse({ schemaVersion: "openpond.modelBinding.v1", id: "prior", profileId: "profile", role: "chat_manual", roleTargetId: "qualified-target", modelArtifactLineageId: "prior-lineage", tasksetId: "taskset", evaluationArtifactId: null, status: "active", priorBindingId: null, rollbackTargetBindingId: null, promotedBy: "owner", promotedAt: time, rolledBackAt: null, metadata: {} });
    await first.saveModelBinding(original);
    const grant = ConversationServingGrantSchema.parse({ id: "grant", revision: 1, ownerInstanceId: "native-owner", teamId: "team", profileId: "profile", projectId: "project", hostedModelId: "model", role: original.role, roleTargetId: original.roleTargetId, expectedBindingId: original.id, policyId: "policy", authorizedConfigurationHash: hash, enabled: true, updatedAt: time });
    await first.saveConversationServingGrant(grant, 0);
    second = new SqliteStore(directory);
    expect((await second.listConversationServingGrants())[0]?.revision).toBe(1);
    await expect(second.saveConversationServingGrant({ ...grant, id: "competing-owner", ownerInstanceId: "other-instance", teamId: "other-team" }, 0)).rejects.toThrow();
    await first.saveConversationServingGrant({ ...grant, enabled: false, revision: 2 }, 1);
    const candidate = ModelBindingSchema.parse({ ...original, id: "candidate", modelArtifactLineageId: "candidate-lineage", priorBindingId: original.id, rollbackTargetBindingId: original.id, promotedBy: "conversation:rollout" });
    await expect(second.replaceActiveModelBinding({ profileId: grant.profileId, role: grant.role, roleTargetId: grant.roleTargetId, expectedActiveBindingId: original.id, servingGrant: { id: grant.id, expectedRevision: 1, authorizationHash: hash }, next: candidate, timestamp: time })).rejects.toThrow();
    expect((await first.getActiveModelBinding(grant))?.id).toBe(original.id);
    await first.saveConversationServingGrant({ ...grant, revision: 3 }, 2);
    await second.replaceActiveModelBinding({ profileId: grant.profileId, role: grant.role, roleTargetId: grant.roleTargetId, expectedActiveBindingId: original.id, servingGrant: { id: grant.id, expectedRevision: 3, authorizationHash: hash }, next: candidate, timestamp: time });
    await first.saveConversationServingGrant({ ...grant, revision: 4, expectedBindingId: candidate.id }, 3);
    const compete = (store: SqliteStore, id: string) => store.replaceActiveModelBinding({ profileId: grant.profileId, role: grant.role, roleTargetId: grant.roleTargetId, expectedActiveBindingId: candidate.id, servingGrant: { id: grant.id, expectedRevision: 4, authorizationHash: hash }, next: { ...candidate, id, priorBindingId: candidate.id, rollbackTargetBindingId: candidate.id }, timestamp: time });
    const competitors = await Promise.allSettled([compete(first, "candidate-a"), compete(second, "candidate-b")]);
    expect(competitors.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const active = await first.getActiveModelBinding(grant);
    expect(["candidate-a", "candidate-b"]).toContain(active?.id);
    const intent = ConversationServingExecutionSchema.parse({ id: "rollout", grantId: grant.id, revision: 1, jobId: "retained-job", artifactHash: hash, priorBindingId: original.id, bindingId: null, restoredBindingId: null, status: "prepared", leaseId: "exact-lease", canarySeconds: 30, activatedAt: null, failure: null, createdAt: time, updatedAt: time });
    await first.saveConversationServingExecution(intent, 0);
    await expect(second.saveConversationServingExecution({ ...intent, revision: 2, jobId: "different-job" }, 1)).rejects.toThrow();
    await expect(second.saveConversationServingGrant({ ...grant, revision: 5, teamId: "different-owner" }, 4)).rejects.toThrow();
    await first.close(); await second.close(); second = null;
    first = new SqliteStore(directory);
    expect((await first.listConversationServingExecutions(grant.id))[0]).toEqual(intent);
    const restored = { ...original, id: "restored", priorBindingId: active!.id };
    await first.replaceActiveModelBinding({ profileId: grant.profileId, role: grant.role, roleTargetId: grant.roleTargetId, expectedActiveBindingId: active!.id, next: restored, timestamp: time });
    expect((await first.getActiveModelBinding(grant))?.id).toBe(restored.id);
    expect((await first.getModelBinding(active!.id))?.status).toBe("rolled_back");
  } finally { await first.close(); await second?.close(); await rm(directory, { recursive: true, force: true }); }
});
