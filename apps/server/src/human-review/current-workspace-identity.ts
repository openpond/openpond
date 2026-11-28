import { createOpenPondSandboxClient } from "@openpond/cloud";
import { loadAuthenticatedOpenPondAccountContext, loadOpenPondAccountContext } from "@openpond/runtime";

/** Read identity at each boundary rather than retaining a startup account. */
export function createCurrentWorkspaceIdentity(input: {
  defaultTeam(): Promise<string | null | undefined>;
}) {
  const personalReads = new Map<string, Promise<string | null>>();

  async function personalTeam(apiBaseUrl: string, token: string): Promise<string | null> {
    const key = JSON.stringify([apiBaseUrl, token]);
    const pending = personalReads.get(key);
    if (pending) return pending;
    const request = createOpenPondSandboxClient({ apiKey: token, baseUrl: apiBaseUrl }).listOrganizations().then(organizations => {
      const personal = organizations.filter(organization =>
        organization.status === "active" && organization.role === "owner" &&
        (organization.workspaceKind === "personal" || organization.kind === "personal_default" || organization.isPersonalDefault === true));
      return personal.length === 1 ? personal[0].teamId?.trim() || null : null;
    });
    personalReads.set(key, request);
    try { return await request; }
    finally { personalReads.delete(key); }
  }

  async function authenticatedAccount() {
    const context = await loadAuthenticatedOpenPondAccountContext();
    const actorId = context.accountState.profile?.id;
    const token = context.token?.trim();
    if (context.accountState.state !== "signed_in" || !actorId || !token) {
      throw new Error("Sign in before accessing this workspace.");
    }
    return { context, actorId, token };
  }

  async function access() {
    const selectedTeam = (await input.defaultTeam())?.trim() || null;
    const { context, actorId, token } = await authenticatedAccount();
    const apiBaseUrl = context.apiBaseUrl;
    const teamId = selectedTeam ?? await personalTeam(apiBaseUrl, token);
    const [current, currentTeam] = await Promise.all([
      loadOpenPondAccountContext(),
      input.defaultTeam(),
    ]);
    if (
      current.token?.trim() !== token || current.apiBaseUrl !== apiBaseUrl ||
      JSON.stringify(current.accountState.activeProfile) !== JSON.stringify(context.accountState.activeProfile) ||
      (currentTeam?.trim() || null) !== selectedTeam
    ) {
      throw new Error("The account or workspace changed while resolving access. Try again.");
    }
    if (!teamId) throw new Error("The signed-in account has no active Personal workspace.");
    return { actorId, teamId, apiBaseUrl, token };
  }

  return {
    access,
    async actorId() { return (await authenticatedAccount()).actorId; },
    async teamId() { return (await access()).teamId; },
  };
}
