import { describe, expect, test } from "vitest";
import type { AccountState } from "@openpond/contracts";
import { preserveCachedAccountIdentities } from "../apps/server/src/openpond/server-openpond-cache";

function accountState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    state: "auth_error",
    activeProfile: {
      handle: "qa",
      baseUrl: "https://openpond.ai",
    },
    label: "qa",
    email: null,
    avatarUrl: null,
    environment: "staging",
    baseUrl: "https://openpond.ai",
    apiBaseUrl: "https://api.openpond.ai",
    chatApiBaseUrl: "https://api.openpond.ai/opchat/v1",
    creditsLabel: null,
    profile: null,
    products: [],
    apiHealth: null,
    accounts: [],
    error: "Unauthorized",
    ...overrides,
  };
}

describe("preserveCachedAccountIdentities", () => {
  test("retains last-known email and display identity while using fresh auth status", () => {
    const fresh = accountState({
      accounts: [
        {
          handle: "qa",
          baseUrl: "https://openpond.ai",
          apiBaseUrl: "https://api.openpond.ai",
          chatApiBaseUrl: null,
          environment: "staging",
          isActive: true,
          authHealth: "auth_error",
          displayLabel: "qa",
          email: null,
          avatarUrl: null,
        },
      ],
    });
    const cached = accountState({
      state: "signed_in",
      label: "QA User",
      email: "qa@example.com",
      error: null,
      accounts: [
        {
          ...fresh.accounts[0]!,
          authHealth: "signed_in",
          displayLabel: "QA User",
          email: "qa@example.com",
          avatarUrl: "https://example.com/avatar.png",
        },
      ],
    });

    expect(preserveCachedAccountIdentities(fresh, [cached])).toMatchObject({
      state: "auth_error",
      label: "QA User",
      email: "qa@example.com",
      error: "Unauthorized",
      accounts: [
        {
          authHealth: "auth_error",
          displayLabel: "QA User",
          email: "qa@example.com",
          avatarUrl: "https://example.com/avatar.png",
        },
      ],
    });
  });
});
