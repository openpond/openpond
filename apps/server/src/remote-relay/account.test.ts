import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AppPreferencesSchema } from "@openpond/contracts";
import type { RuntimeAccountContext } from "@openpond/runtime";
import { remoteRelayAccount, remoteRelayAccountStatus } from "./account.js";

const account = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@openpond/runtime", () => ({
  loadAuthenticatedOpenPondAccountContext: account.load,
  loadOpenPondAccountContext: account.load,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Failure story: a signed-in personal account is silently gated on a workspace,
// or its outbound enrollment inherits a workspace header and wrong authority.
it.each([null, "fixture-team"])("captures the exact %s account scope without selecting another workspace", async teamId => {
  const context = {
    config: {}, profiles: [], account: null,
    token: "fixture-credential", apiBaseUrl: "https://fixture.invalid/v1",
    chatApiBaseUrl: "https://fixture.invalid/v1",
    accountState: {
      state: "signed_in", label: "Fixture account",
      activeProfile: { handle: "fixture-profile", baseUrl: "https://fixture.invalid" },
      profile: { id: "fixture-owner" }, baseUrl: "https://fixture.invalid",
    },
  } as unknown as RuntimeAccountContext;
  account.load.mockResolvedValue(context);
  vi.stubEnv("OPENPOND_API_KEY", "fixture-other-account-key");
  const fetch = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const preferences = async () => AppPreferencesSchema.parse({ defaultTeamId: teamId });
  const read = remoteRelayAccount(randomUUID(), preferences);
  const selected = (await read())!;
  expect(selected.owner).toMatchObject({ ownerUserId: "fixture-owner", teamId });
  await selected.request({ path: "/remote-devices/service-keys" });
  const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(options.headers);
  expect(headers.get("X-OpenPond-Team-Id")).toBe(teamId);
  expect(headers.get("Authorization")).toBe("Bearer fixture-credential");
  expect(headers.get("openpond-api-key")).toBeNull();
  expect((await remoteRelayAccountStatus(preferences)).state).toBe("ready");
  account.load.mockResolvedValue({ ...context, token: "opk_fixture_credential" });
  const apiKeySelected = (await read())!;
  await apiKeySelected.request({ path: "/remote-devices/service-keys" });
  const [, keyOptions] = fetch.mock.calls[1] as unknown as [string, RequestInit];
  const keyHeaders = new Headers(keyOptions.headers);
  expect(keyHeaders.get("Authorization")).toBe("ApiKey opk_fixture_credential");
  expect(keyHeaders.get("openpond-api-key")).toBe("opk_fixture_credential");
  expect(keyHeaders.get("X-OpenPond-Team-Id")).toBe(teamId);
  account.load.mockResolvedValue({ ...context, token: null, accountState: { ...context.accountState, state: "signed_out", profile: null } });
  expect(await read()).toBeNull();
  expect((await remoteRelayAccountStatus(preferences)).state).toBe("signed_out");
  expect(fetch).toHaveBeenCalledTimes(2);
});
