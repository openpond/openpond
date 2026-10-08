import { createHash } from "node:crypto";
import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import type { AppPreferences } from "@openpond/contracts";
import { createCapturedOpenPondPublicApiClient } from "../openpond/sandboxes.js";
import { deviceLocalOwner } from "./local-scope.js";

export function remoteRelayAccount(installationId: string, preferences: () => Promise<AppPreferences>) {
  return async () => {
    const context = await loadAuthenticatedOpenPondAccountContext();
    const teamId = (await preferences()).defaultTeamId;
    if (!teamId || context.accountState.state !== "signed_in") return null;
    const client = createCapturedOpenPondPublicApiClient(context, teamId);
    const owner = deviceLocalOwner(context, installationId, teamId, client.audience);
    if (!owner) return null;
    return { owner, credentialKey: createHash("sha256").update(JSON.stringify([context.token, context.apiBaseUrl])).digest("hex"), request: client.request };
  };
}
