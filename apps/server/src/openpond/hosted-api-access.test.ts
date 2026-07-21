import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeAccountContext } from "@openpond/runtime";
import {
  MANAGED_ADAPTER_CONTROL_RUNTIME_ENV,
  MANAGED_ADAPTER_SERVICE_API_KEY_ENV,
  MANAGED_ADAPTER_TEAM_ID_ENV,
  resolveHostedApiAccess,
  resolveManagedAdapterControlAccess,
  resolveManagedAdapterUserAccess,
} from "./hosted-api-access.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted API access identities", () => {
  test("keeps the signed-in account identity on customer inference", async () => {
    vi.stubEnv(MANAGED_ADAPTER_SERVICE_API_KEY_ENV, "opk_service");
    await expect(
      resolveHostedApiAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).resolves.toEqual({
      apiBaseUrl: "https://api.staging.test",
      token: "opk_user",
    });
  });

  test("requires the dedicated service identity for trusted control calls", async () => {
    vi.stubEnv(MANAGED_ADAPTER_CONTROL_RUNTIME_ENV, "trusted-hosted");
    vi.stubEnv(MANAGED_ADAPTER_SERVICE_API_KEY_ENV, "");
    await expect(
      resolveManagedAdapterControlAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).rejects.toThrow(MANAGED_ADAPTER_SERVICE_API_KEY_ENV);
  });

  test("requires one explicit team for user registry and inference access", async () => {
    vi.stubEnv(MANAGED_ADAPTER_TEAM_ID_ENV, "");
    await expect(
      resolveManagedAdapterUserAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).rejects.toThrow(MANAGED_ADAPTER_TEAM_ID_ENV);

    vi.stubEnv(MANAGED_ADAPTER_TEAM_ID_ENV, "team_qa");
    await expect(
      resolveManagedAdapterUserAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).resolves.toEqual({
      apiBaseUrl: "https://api.staging.test",
      token: "opk_user",
      teamId: "team_qa",
    });
  });

  test("uses the authenticated UI-selected team instead of the QA environment pin", async () => {
    vi.stubEnv(MANAGED_ADAPTER_TEAM_ID_ENV, "team_qa");
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

  test("refuses publication from an untrusted desktop runtime even when the key exists", async () => {
    vi.stubEnv(MANAGED_ADAPTER_SERVICE_API_KEY_ENV, "opk_service");
    await expect(
      resolveManagedAdapterControlAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).rejects.toThrow("trusted hosted bridge");
  });

  test("never substitutes the signed-in account token in a trusted hosted runtime", async () => {
    vi.stubEnv(MANAGED_ADAPTER_CONTROL_RUNTIME_ENV, "trusted-hosted");
    vi.stubEnv(MANAGED_ADAPTER_SERVICE_API_KEY_ENV, "opk_service");
    vi.stubEnv(MANAGED_ADAPTER_TEAM_ID_ENV, "team_qa");
    await expect(
      resolveManagedAdapterControlAccess({
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).resolves.toEqual({
      apiBaseUrl: "https://api.staging.test",
      token: "opk_service",
      teamId: "team_qa",
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
