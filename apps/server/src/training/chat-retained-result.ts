import { ChatContextSelectionSchema, type ChatContextTarget, type ChatContextSelection } from "@openpond/contracts";
import { createTrainingClient, StoredExperimentResultReferenceSchema } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

type Access = { apiBaseUrl: string; token: string; teamId: string; actorId: string };
/** Result pins describe immutable evidence, not the mutable outer execution or
 * a later saved Model. Every resolve reauthorizes the configured account. */
export async function readChatRetainedResult(target: ChatContextTarget,
  access: () => Promise<Access>): Promise<ChatContextSelection> {
  const pin = StoredExperimentResultReferenceSchema.parse(target.result), original = await access();
  const origin = new URL(original.apiBaseUrl).origin;
  if (target.kind !== pin.kind || target.location !== "cloud" || target.teamId !== original.teamId ||
    target.apiOrigin !== origin || pin.apiOrigin !== origin || pin.owner.teamId !== original.teamId ||
    pin.owner.actorId !== original.actorId || target.id !== (pin.kind === "training_result" ? pin.jobId : pin.executionId))
    throw new Error("Select this exact result in its original account and workspace.");
  async function fence() {
    const current = await access();
    if (current.actorId !== original.actorId || current.teamId !== original.teamId || new URL(current.apiBaseUrl).origin !== origin)
      throw new Error("The active account changed while reading the retained result.");
  }
  const headers = hostedApiAuthHeaders(original.token); headers.set("x-openpond-team-id", original.teamId);
  const client = createTrainingClient({ baseUrl: original.apiBaseUrl, headers, fetch: async (url, init) => {
    await fence();
    const response = await fetch(url, { ...init, redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]) });
    await fence(); return response;
  } });
  let selection: ChatContextSelection;
  if (pin.kind === "training_result") {
    const value = await client.result(pin.jobId, { teamId: original.teamId });
    // Training's compact Job omits workspace Project metadata. The existing
    // authorized Project history owner verifies a non-null producing Project.
    if (pin.projectId !== null) {
      const page = await client.listExecutions(original.teamId, { projectId: pin.projectId, search: pin.jobId, limit: 100 });
      if (!page.items.some(item => item.job.id === pin.jobId)) throw new Error("The training result does not belong to this Project.");
    }
    selection = { target, label: value.name, detail: `Retained training checkpoint · ${pin.jobId}`,
      results: [pin], trainingResult: value };
  } else if (pin.kind === "managed_modification_result") {
    const value = await client.getModificationExecution(original.teamId, pin.executionId, { ownerUserId: original.actorId });
    selection = { target, label: value.name, detail: `Completed ${value.method} · ${value.id}`,
      results: [pin], managedModificationResult: value };
  } else if (pin.kind === "engram_result") {
    const value = await client.getEngramExecution(original.teamId, pin.executionId, { ownerUserId: original.actorId });
    selection = { target, label: value.name, detail: `Completed Engram · ${value.id}`, results: [pin], engramResult: value };
  } else throw new Error("Use this result's canonical reader.");
  await fence();
  return ChatContextSelectionSchema.parse(selection);
}
