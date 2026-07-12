import { describe, expect, test } from "bun:test";
import type { AccountState } from "@openpond/contracts";
import { accountWelcomeIdentity } from "../apps/web/src/hooks/useActiveWorkspaceViewState";

function accountState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    state: "signed_in",
    activeProfile: { handle: "sam+sandbox-test@openpond.ai", baseUrl: "https://staging.openpond.ai" },
    label: "user-e6e4aw",
    email: "sam+qa-user-4@openpond.ai",
    avatarUrl: null,
    environment: "staging",
    baseUrl: "https://staging.openpond.ai",
    apiBaseUrl: "https://staging.openpond.ai/api",
    chatApiBaseUrl: "https://staging.openpond.ai/api",
    balanceLabel: "$0.00",
    balance: null,
    creditsLabel: null,
    profile: null,
    products: [],
    apiHealth: null,
    accounts: [],
    error: null,
    ...overrides,
  };
}

describe("accountWelcomeIdentity", () => {
  test("prefers the authenticated email over the local profile selector", () => {
    expect(accountWelcomeIdentity(accountState())).toBe("sam+qa-user-4@openpond.ai");
  });

  test("uses authenticated profile data before the configured selector", () => {
    expect(accountWelcomeIdentity(accountState({
      email: null,
      profile: {
        id: "user-e6e4aw",
        email: "sam+qa-user-4@openpond.ai",
        name: null,
        handle: "user-e6e4aw",
        image: null,
        timezone: null,
        isAdmin: false,
        isVerified: true,
        dailyAgentAppId: null,
        dailyAgentDeploymentId: null,
        credits: null,
        turnkeyWalletAddress: null,
        turnkeyOperatingWalletAddress: null,
      },
    }))).toBe("sam+qa-user-4@openpond.ai");
  });

  test("does not expose a saved selector while signed out", () => {
    expect(accountWelcomeIdentity(accountState({ state: "signed_out", email: null }))).toBe("");
  });
});
