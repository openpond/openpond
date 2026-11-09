import { ChatContextTargetSchema, type ChatContextTarget } from "@openpond/contracts";
import { createTrainingClient } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

type Access = { apiBaseUrl: string; token: string; teamId: string; actorId: string };
export async function readChatWeightSpace(raw: ChatContextTarget, access: () => Promise<Access>) {
  const target = ChatContextTargetSchema.parse(raw), original = await access();
  const origin = new URL(original.apiBaseUrl).origin;
  if (target.kind !== "weight_space_session" || target.location !== "cloud" || target.teamId !== original.teamId || target.apiOrigin !== origin)
    throw new Error("Open this editing session in its original account and workspace.");
  const headers = hostedApiAuthHeaders(original.token); headers.set("x-openpond-team-id", original.teamId);
  const client = createTrainingClient({ baseUrl: original.apiBaseUrl, headers, fetch: async (url, init) => {
    const current = await access();
    if (current.actorId !== original.actorId || current.teamId !== original.teamId || current.apiBaseUrl !== original.apiBaseUrl)
      throw new Error("The account changed while reading the editing session.");
    return fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) });
  }});
  const weightSpace = await client.getWeightSpaceSession(original.teamId, target.id, { ownerUserId: original.actorId });
  const current = await access();
  if (current.actorId !== original.actorId || current.teamId !== original.teamId || current.apiBaseUrl !== original.apiBaseUrl)
    throw new Error("The account changed while reading the editing session.");
  return { target, label: weightSpace.name, detail: `Weight-space programming · ${weightSpace.phase}`, weightSpace };
}
