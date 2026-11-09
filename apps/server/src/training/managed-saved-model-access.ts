import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import { canonicalJson, createTrainingClient } from "openpond-sdk/training";
import { hostedApiAuthHeaders, resolveManagedAdapterUserAccess } from "../openpond/hosted-api-access.js";
type Access = Awaited<ReturnType<typeof configuredAccess>>;

export async function configuredAccess(teamId: string) {
  const context = await loadAuthenticatedOpenPondAccountContext();
  const actorId = context.accountState.profile?.id;
  if (context.accountState.state !== "signed_in" || !actorId) throw new Error("Sign in to use this saved steering Model.");
  return {...await resolveManagedAdapterUserAccess({teamId, loadAccountContext: async () => context}), actorId};
}
export function identity(access: Access) {
  return {teamId: access.teamId, actorId: access.actorId, apiOrigin: new URL(access.apiBaseUrl).origin};
}
export function clientFor(
  access: Access,
  fence: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): ReturnType<typeof createTrainingClient> {
  return createTrainingClient({baseUrl: access.apiBaseUrl, headers: () => {
    const headers = hostedApiAuthHeaders(access.token); headers.set("x-openpond-team-id", access.teamId); return headers;
  }, fetch: async (...args) => {await fence(); const response = await fetchImpl(...args); await fence(); return response;}});
}
export async function accountFence(original: Access) {
  if (canonicalJson(identity(await configuredAccess(original.teamId))) !== canonicalJson(identity(original)))
    throw new Error("The account changed. Select this saved Model in its original account and workspace.");
}
