import { describe, expect, test } from "vitest";
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
  test("uses a human-readable account label instead of the authenticated email", () => {
    expect(accountWelcomeIdentity(accountState({ label: "Sam Cesario" }))).toBe("Sam Cesario");
  });

  test("prefers the authenticated profile name over other account labels", () => {
    expect(accountWelcomeIdentity(accountState({
      label: "Sam's account",
      profile: {
        id: "user-e6e4aw",
        email: "sam+qa-user-4@openpond.ai",
        name: "Sam Cesario",
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
    }))).toBe("Sam Cesario");
  });

  test("does not expose an email when no display name is available", () => {
    expect(accountWelcomeIdentity(accountState({
      label: "sam+qa-user-4@openpond.ai",
      activeProfile: { handle: "sam+sandbox-test@openpond.ai", baseUrl: "https://staging.openpond.ai" },
      accounts: [{
        handle: "sam+qa-user-4@openpond.ai",
        baseUrl: "https://staging.openpond.ai",
        apiBaseUrl: "https://staging.openpond.ai/api",
        chatApiBaseUrl: "https://staging.openpond.ai/api",
        environment: "staging",
        isActive: true,
        authHealth: "signed_in",
        displayLabel: "sam+qa-user-4@openpond.ai",
        email: "sam+qa-user-4@openpond.ai",
        avatarUrl: null,
      }],
    }))).toBe("");
  });

  test("does not expose a saved selector while signed out", () => {
    expect(accountWelcomeIdentity(accountState({ state: "signed_out", email: null }))).toBe("");
  });
});
