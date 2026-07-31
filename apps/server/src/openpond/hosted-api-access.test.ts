import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeAccountContext } from "@openpond/runtime";
import { resolveHostedApiAccess, resolveManagedAdapterUserAccess } from "./hosted-api-access.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted API access identities", () => {
  test("keeps the saved desktop account identity on customer inference", async () => {
    vi.stubEnv("OPENPOND_SANDBOX_API_KEY", "opk_environment");
    vi.stubEnv("OPENPOND_API_URL", "https://api.environment.test");
    await expect(
      resolveHostedApiAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).resolves.toEqual({
      apiBaseUrl: "https://api.staging.test",
      token: "opk_user",
    });
  });

  test("requires the desktop-selected workspace for managed access", async () => {
    vi.stubEnv("OPENPOND_MODEL_ADAPTER_TEAM_ID", "team_environment");
    await expect(
      resolveManagedAdapterUserAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).rejects.toThrow("Select an OpenPond workspace");

    await expect(
      resolveManagedAdapterUserAccess({
        loadAccountContext: async () => accountContext("opk_user"),
        teamId: "team_customer",
      }),
    ).resolves.toEqual({
      apiBaseUrl: "https://api.staging.test",
      token: "opk_user",
      teamId: "team_customer",
    });
  });

  test("ignores an environment workspace pin", async () => {
    vi.stubEnv("OPENPOND_MODEL_ADAPTER_TEAM_ID", "team_environment");
    await expect(
      resolveManagedAdapterUserAccess({
        loadAccountContext: async () => accountContext("opk_user"),
        teamId: "team_customer",
      }),
    ).resolves.toEqual({
      apiBaseUrl: "https://api.staging.test",
      token: "opk_user",
      teamId: "team_customer",
    });
  });
});

function accountContext(token: string): RuntimeAccountContext {
  return {
    config: { apiBaseUrl: "https://api.staging.test" },
    profiles: [],
    account: null,
    token,
    apiBaseUrl: "https://api.staging.test",
    chatApiBaseUrl: "https://api.staging.test",
    accountState: {} as RuntimeAccountContext["accountState"],
  };
}
