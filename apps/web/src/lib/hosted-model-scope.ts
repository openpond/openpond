import type { AccountState } from "@openpond/contracts";
import type { OpenPondOrganization } from "./organization-types";

export function personalModelWorkspaceId(organizations: readonly OpenPondOrganization[]) {
  const personal = organizations.filter(organization =>
    organization.status === "active" && organization.role === "owner" &&
    (organization.workspaceKind === "personal" || organization.isPersonalDefault || organization.kind === "personal_default"));
  return personal.length === 1 ? personal[0]?.teamId ?? null : null;
}

export function hostedModelScope(
  account: Pick<AccountState, "state" | "apiBaseUrl" | "profile"> | null | undefined,
  teamId: string | null | undefined,
) {
  const apiUrl = account?.apiBaseUrl;
  const selectedTeamId = teamId?.trim();
  if (account?.state !== "signed_in" || !selectedTeamId || !apiUrl || !URL.canParse(apiUrl)) return null;
  return { teamId: selectedTeamId, apiOrigin: new URL(apiUrl).origin, actorId: account.profile?.id ?? null };
}
