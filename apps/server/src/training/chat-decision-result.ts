import { StoredDecisionResultReferenceSchema, type ChatContextTarget, type ChatContextSelection } from "@openpond/contracts";
import { canonicalJson, createTrainingClient } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

type Access = {apiBaseUrl: string; token: string; teamId: string; actorId: string};
/** Reauthorizes the exact retained result through the configured hosted owner.
 * A mutable execution read hash or a later saved Model is never its identity. */
export async function readChatDecisionResult(target: ChatContextTarget, access: () => Promise<Access>): Promise<ChatContextSelection> {
  const reference = StoredDecisionResultReferenceSchema.parse(target.result), original = await access();
  const origin = new URL(original.apiBaseUrl).origin;
  async function fence() {
    const current = await access();
    if (current.teamId !== original.teamId || current.actorId !== original.actorId || new URL(current.apiBaseUrl).origin !== origin)
      throw new Error("The active account changed. Select this result in its original account.");
  }
  if (target.kind !== "decision_result" || target.id !== reference.executionId || reference.apiOrigin !== origin
    || reference.owner.teamId !== original.teamId || reference.owner.actorId !== original.actorId)
    throw new Error("Select the exact decision result in its original account and workspace.");
  const headers = hostedApiAuthHeaders(original.token); headers.set("x-openpond-team-id", original.teamId);
  const execution = await createTrainingClient({baseUrl: original.apiBaseUrl, headers, fetch: async (...args) => {
    await fence(); const response = await fetch(...args); await fence(); return response;
  }}).getDecisionExecution(original.teamId, reference.executionId, {ownerUserId: original.actorId});
  await fence();
  const result = execution.result;
  if (execution.phase !== "completed" || !result || execution.projectId !== reference.projectId || execution.mode !== reference.mode
    || execution.plan.inputHash !== reference.inputHash || result.modelHash !== reference.modelHash || result.runtimeHash !== reference.runtimeHash
    || result.contentHash !== reference.resultHash || canonicalJson(result.artifact === null ? null : {id: result.artifact.id, contentHash: result.artifact.contentHash}) !== canonicalJson(reference.artifact))
    throw new Error("The retained decision result differs from its exact mode, input, artifact or runtime.");
  return {target, label: execution.name, detail: `Completed decision ${execution.mode} · ${execution.id}`,
    results: [reference], decisionResult: execution};
}
