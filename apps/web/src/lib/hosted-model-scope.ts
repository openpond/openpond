import type { AccountState } from "@openpond/contracts";

export function hostedModelScope(
  account: Pick<AccountState, "state" | "apiBaseUrl"> | null | undefined,
  teamId: string | null | undefined,
) {
  const apiUrl = account?.apiBaseUrl;
  const selectedTeamId = teamId?.trim();
  if (account?.state !== "signed_in" || !selectedTeamId || !apiUrl || !URL.canParse(apiUrl)) return null;
  return { teamId: selectedTeamId, apiOrigin: new URL(apiUrl).origin };
}
