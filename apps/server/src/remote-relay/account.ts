import { createHash } from "node:crypto";
import { DEFAULT_OPENPOND_API_BASE_URL, DEFAULT_OPENPOND_WEB_BASE_URL } from "@openpond/cloud/urls";
import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import type {
  AppPreferences,
  RemoteAccessAccountStatus,
} from "@openpond/contracts";
import { createCapturedOpenPondPublicApiClient } from "../openpond/account-public-api-client.js";
import { deviceLocalOwner } from "./local-scope.js";

export function remoteRelayAccount(
  installationId: string,
  preferences: () => Promise<AppPreferences>,
) {
  return async () => {
    const context = await loadAuthenticatedOpenPondAccountContext();
    const teamId = (await preferences()).defaultTeamId?.trim() || null;
    if (context.accountState.state !== "signed_in") return null;
    const client = createCapturedOpenPondPublicApiClient(context, teamId ?? undefined);
    const owner = deviceLocalOwner(
      context,
      installationId,
      teamId,
      client.audience,
    );
    if (!owner) return null;
    return {
      owner,
      credentialKey: createHash("sha256")
        .update(JSON.stringify([context.token, context.apiBaseUrl]))
        .digest("hex"),
      request: client.request,
    };
  };
}

/** Presentation uses the authenticated account; it never grants device authority. */
export async function remoteRelayAccountStatus(
  preferences: () => Promise<AppPreferences>,
): Promise<RemoteAccessAccountStatus> {
  const context = await loadAuthenticatedOpenPondAccountContext();
  const account = context.accountState;
  const teamId = (await preferences()).defaultTeamId?.trim() || null;
  const signedIn = account.state === "signed_in" && !!account.profile?.id;
  const baseUrl = account.activeProfile?.baseUrl ?? account.baseUrl;
  let webBaseUrl: string | null = null;
  if (baseUrl) {
    const url = new URL(baseUrl);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol === "https:" || local) && !url.username && !url.password && !url.search && !url.hash) {
      webBaseUrl = url.origin === DEFAULT_OPENPOND_API_BASE_URL ? DEFAULT_OPENPOND_WEB_BASE_URL : url.origin;
    }
  }
  return {
    state: signedIn ? "ready" : "signed_out",
    account: signedIn
      ? { id: account.profile!.id!, label: account.label }
      : null,
    team: signedIn && teamId ? { id: teamId } : null,
    webBaseUrl,
  };
}
