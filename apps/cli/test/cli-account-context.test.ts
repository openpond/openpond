import { afterEach, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/common/args";
import { runCliCommand } from "../src/cli/command-registry";

const state = vi.hoisted(() => ({
  defaultTeamId: "qa-team",
  token: "opk_fixture_private",
  apiOrigin: "https://api.fixture.test",
}));
vi.mock("@openpond/runtime", () => ({
  loadOpenPondAccountContext: async () => ({
    account: { handle: "fixture-account", baseUrl: "https://fixture.test", apiKey: state.token },
    token: state.token,
    apiBaseUrl: state.apiOrigin,
    config: { accounts: [{ apiKey: "other-private-key" }] },
  }),
}));
vi.mock("@openpond/persistence", () => ({
  resolveOpenPondHome: () => "/fixture-home",
  readConfig: async () => ({ document: { defaults: { team_id: state.defaultTeamId } } }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The companion must never receive credentials or select a different tenant
// when a configured default disappears; cross-origin reads must fail closed.
test("official account context binds safe team discovery to its account and refuses stale default fallback", async () => {
  vi.stubEnv("OPENPOND_API_KEY", state.token);
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`${state.apiOrigin}/v1/organizations`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`ApiKey ${state.token}`);
    return new Response(
      JSON.stringify({
        organizations: [
          {
            teamId: "personal-team",
            displayName: "Personal",
            role: "owner",
            status: "active",
            isPersonalDefault: true,
          },
          { teamId: "qa-team", displayName: "QA", role: "admin", status: "active" },
          { teamId: "disabled-team", displayName: "Disabled", role: "admin", status: "disabled" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", request);
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value) => {
    output.push(String(value));
  });
  try {
    await runCliCommand(parseArgs(["account", "context", "--json"]));
    const result = JSON.parse(output[0]!);
    expect(result.selectedTeamId).toBe("qa-team");
    expect(result.selection).toBe("configuredDefault");
    expect(result.teams.map((team: { teamId: string }) => team.teamId)).toEqual([
      "personal-team",
      "qa-team",
    ]);
    expect(result.account).toEqual({
      handle: "fixture-account",
      baseUrl: "https://fixture.test",
      apiOrigin: state.apiOrigin,
    });
    expect(output[0]).not.toContain(state.token);
    expect(output[0]).not.toMatch(/other-private-key|apiKey|token|fixture-home/);
    state.defaultTeamId = "removed-team";
    await runCliCommand(parseArgs(["account", "context", "--json"]));
    expect(JSON.parse(output[1]!)).toMatchObject({
      defaultTeamId: "removed-team",
      selectedTeamId: null,
      selection: "unavailableDefault",
    });
    const count = request.mock.calls.length;
    await expect(
      runCliCommand(
        parseArgs(["account", "context", "--api-base-url", "https://other.test", "--json"]),
      ),
    ).rejects.toThrow("API origin");
    expect(request.mock.calls.length).toBe(count);
    vi.stubEnv("OPENPOND_API_KEY", "opk_other_private");
    await expect(runCliCommand(parseArgs(["account", "context", "--json"]))).rejects.toThrow(
      "differs from the selected account",
    );
    expect(request.mock.calls.length).toBe(count);
  } finally {
    log.mockRestore();
    state.defaultTeamId = "qa-team";
  }
});
