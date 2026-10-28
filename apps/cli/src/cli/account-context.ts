import { createOpenPondSandboxClient } from "@openpond/cloud";
import { readConfig, resolveOpenPondHome } from "@openpond/persistence";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import { optionString } from "./common/options";
import { resolveApiBaseUrlOption, resolveBaseUrlOption } from "./common/urls";

/** Credential-free, account-bound metadata for companion clients. Never return
 * RuntimeAccountContext itself: it contains credentials and unrelated profiles. */
export async function readAccountTeamContext(options: Record<string, string | boolean>) {
  const context = await loadOpenPondAccountContext(
    optionString(options, "account"),
    resolveBaseUrlOption(options),
  );
  if (!context.account || !context.token)
    throw new Error("Sign in to the selected OpenPond account before reading its teams.");
  if (process.env.OPENPOND_API_KEY?.trim() && process.env.OPENPOND_API_KEY.trim() !== context.token)
    throw new Error(
      "OPENPOND_API_KEY differs from the selected account. Remove that override before reading account-bound teams.",
    );
  const apiUrl = new URL(resolveApiBaseUrlOption(options) ?? context.apiBaseUrl);
  if (apiUrl.origin !== new URL(context.apiBaseUrl).origin || apiUrl.username || apiUrl.password)
    throw new Error("The API URL must match the selected account’s API origin.");
  const client = createOpenPondSandboxClient({ apiKey: context.token, baseUrl: apiUrl.origin });
  const organizations = await client.listOrganizations();
  if (organizations.length > 200)
    throw new Error(
      "Account team discovery exceeds 200 records; pass an explicit --team-id to the viewer.",
    );
  const teams = organizations
    .filter((team) => team.status === "active")
    .map((team) => ({
      teamId: team.teamId,
      name: (team.displayName || team.name || team.slug).slice(0, 191),
      role: team.role,
      personalDefault:
        team.isPersonalDefault === true ||
        team.kind === "personal_default" ||
        team.workspaceKind === "personal",
    }));
  const ids = new Set<string>();
  for (const team of teams) {
    if (!team.teamId || team.teamId.length > 191 || ids.has(team.teamId))
      throw new Error("The account returned invalid or duplicate team identities.");
    ids.add(team.teamId);
  }
  const config = await readConfig(resolveOpenPondHome());
  const defaultTeamId = config.document.defaults?.team_id?.trim() || null;
  const personal = teams.filter((team) => team.personalDefault);
  const selected = defaultTeamId
    ? teams.find((team) => team.teamId === defaultTeamId)
    : personal.length === 1
      ? personal[0]
      : teams.length === 1
        ? teams[0]
        : undefined;
  return {
    schemaVersion: 1 as const,
    account: {
      handle: context.account.handle,
      baseUrl: context.account.baseUrl ?? null,
      apiOrigin: apiUrl.origin,
    },
    defaultTeamId,
    selectedTeamId: selected?.teamId ?? null,
    selection: selected
      ? defaultTeamId
        ? "configuredDefault"
        : personal.length === 1
          ? "personalDefault"
          : "onlyTeam"
      : defaultTeamId
        ? "unavailableDefault"
        : "chooseTeam",
    teams,
  };
}

export async function runAccountContext(options: Record<string, string | boolean>): Promise<void> {
  console.log(JSON.stringify(await readAccountTeamContext(options), null, 2));
}
