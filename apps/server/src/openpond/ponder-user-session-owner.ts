import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import type { AppPreferences, Session } from "@openpond/contracts";
import { createCapturedOpenPondPublicApiClient } from "./sandboxes.js";
import { ponderLocalOwner, PonderLocalOwnerSchema } from "./ponder-local-scope.js";

export function createPonderUserSessionOwner(input: {
  installationId: string;
  getSession(id: string): Promise<Session | null>;
  loadAppPreferences(): Promise<AppPreferences>;
}) {
  return async (payload: unknown) => {
    const parentId =
      payload && typeof payload === "object" && "parentSessionId" in payload
        ? (payload as { parentSessionId?: unknown }).parentSessionId
        : null;
    if (typeof parentId === "string") {
      const parent = await input.getSession(parentId);
      const owner = PonderLocalOwnerSchema.safeParse(parent?.metadata?.ponderLocalOwner);
      return owner.success ? owner.data : null;
    }
    try {
      const context = await loadAuthenticatedOpenPondAccountContext();
      const teamId = (await input.loadAppPreferences()).defaultTeamId;
      const client = createCapturedOpenPondPublicApiClient(context, teamId ?? undefined);
      return ponderLocalOwner(context, input.installationId, teamId, client.audience);
    } catch {
      return null;
    }
  };
}
