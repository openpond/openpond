import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountState } from "@openpond/contracts";

import { UserAuthFooter, userAuthIdentity } from "../apps/web/src/components/sidebar/UserAuthFooter";

function accountState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    state: "signed_in",
    activeProfile: { handle: "ada", baseUrl: "https://openpond.ai" },
    label: "Ada Lovelace",
    email: "ada@example.com",
    avatarUrl: "https://example.com/ada.png",
    environment: "production",
    baseUrl: "https://openpond.ai",
    apiBaseUrl: "https://api.openpond.ai",
    chatApiBaseUrl: "https://opchat.openpond.ai",
    balanceLabel: "$0.00",
    balance: null,
    creditsLabel: null,
    profile: {
      id: "user_ada",
      email: "ada@example.com",
      name: "Ada Lovelace",
      handle: "ada",
      image: "https://example.com/ada-profile.png",
      timezone: "UTC",
      isAdmin: false,
      isVerified: true,
      dailyAgentAppId: null,
      dailyAgentDeploymentId: null,
      credits: null,
      turnkeyWalletAddress: null,
      turnkeyOperatingWalletAddress: null,
    },
    products: [],
    apiHealth: null,
    accounts: [
      {
        handle: "ada",
        baseUrl: "https://openpond.ai",
        chatApiBaseUrl: "https://opchat.openpond.ai",
        environment: "production",
        isActive: true,
        authHealth: "signed_in",
        displayLabel: "Ada Lovelace",
        email: "ada@example.com",
        avatarUrl: "https://example.com/ada-account.png",
      },
    ],
    error: null,
    ...overrides,
  };
}

describe("UserAuthFooter", () => {
  test("renders the active account avatar and username", () => {
    const markup = renderToStaticMarkup(
      createElement(UserAuthFooter, {
        account: accountState(),
        onOpenSettings: () => undefined,
      }),
    );

    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain('src="https://example.com/ada.png"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).not.toContain("Sign out");
  });

  test("falls back to the active account record when profile details are absent", () => {
    expect(
      userAuthIdentity(
        accountState({
          label: "",
          email: null,
          avatarUrl: null,
          profile: null,
        }),
      ),
    ).toEqual({
      label: "Ada Lovelace",
      image: "https://example.com/ada-account.png",
    });
  });

  test("shows account settings entry states for signed out users", () => {
    expect(
      userAuthIdentity(
        accountState({
          state: "signed_out",
          label: "Signed out",
          email: null,
          avatarUrl: null,
          profile: null,
          accounts: [],
        }),
      ),
    ).toEqual({
      label: "Add account",
      image: null,
    });
  });
});
