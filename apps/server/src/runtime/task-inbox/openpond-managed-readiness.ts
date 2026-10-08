import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import type { AppPreferences, Session } from "@openpond/contracts";
import { DeviceLocalOwnerSchema, deviceLocalOwner, deviceOwnsLocalSession } from "../../remote-relay/local-scope.js";

/** Read account readiness through the same captured ownership used at admission. */
export function createOpenPondManagedReadiness(preferences: () => Promise<AppPreferences>) {
  return async (session: Session): Promise<{ available: boolean; reason: string | null }> => {
    const owner = DeviceLocalOwnerSchema.safeParse(session.metadata?.ponderLocalOwner);
    if (!owner.success) return { available: false, reason: "This OpenPond task has no captured local account owner." };
    try {
      const context = await loadAuthenticatedOpenPondAccountContext();
      const teamId = (await preferences()).defaultTeamId;
      const current = deviceLocalOwner(context, owner.data.installationId, teamId, new URL(context.apiBaseUrl).origin);
      if (!current || !deviceOwnsLocalSession(session, current))
        return { available: false, reason: "Sign in to this task's original OpenPond account and workspace before sending." };
      return { available: true, reason: null };
    } catch {
      return { available: false, reason: "The captured OpenPond account could not be authenticated." };
    }
  };
}
