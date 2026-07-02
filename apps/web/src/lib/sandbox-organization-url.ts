const SANDBOX_ORGANIZATION_TEAM_PARAM = "teamId";

export function normalizeSandboxOrganizationTeamId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function getSandboxOrganizationTeamId(searchParams: Pick<URLSearchParams, "get">): string | null {
  return normalizeSandboxOrganizationTeamId(searchParams.get(SANDBOX_ORGANIZATION_TEAM_PARAM));
}

export function buildSandboxOrganizationHref(params: {
  currentSearch: string;
  pathname: string;
  teamId: string | null;
}): string {
  const nextSearch = new URLSearchParams(params.currentSearch);
  const teamId = normalizeSandboxOrganizationTeamId(params.teamId);
  if (teamId) {
    nextSearch.set(SANDBOX_ORGANIZATION_TEAM_PARAM, teamId);
  } else {
    nextSearch.delete(SANDBOX_ORGANIZATION_TEAM_PARAM);
  }

  const query = nextSearch.toString();
  return query ? `${params.pathname}?${query}` : params.pathname;
}
