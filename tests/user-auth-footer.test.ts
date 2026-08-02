import { describe, expect, test } from "vitest";
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
    },
    products: [],
    workspaces: null,
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
        onSelectWorkspace: async () => undefined,
        onOpenSettings: () => undefined,
      }),
    );

    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain('src="https://example.com/ada.png"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).not.toContain("Sign out");
  });

  test("shows the active team as a cyan footer badge", () => {
    const usage = {
      scope: "workspace" as const,
      limitsScope: "workspace" as const,
      periodStart: "2026-08-01T00:00:00.000Z",
      sandbox: { hours: 0, retailUsd: "0", includedHours: 5, maxConcurrent: 1 },
      opChat: { tokens: 0, includedTokens: 1000 },
      search: { calls: 0, includedCalls: 10 },
      personalizedInference: { requests: 0, includedRequests: 10 },
      totalRetailUsd: "0",
    };
    const personal = {
      id: "personal_ada",
      type: "personal" as const,
      displayName: "Personal",
      role: "owner" as const,
      isBillingAdmin: true,
      canManageBilling: true,
      planKey: "free",
      accessState: "active",
      usage,
    };
    const team = {
      ...personal,
      id: "team_analytical_engine",
      type: "team" as const,
      displayName: "Analytical Engine",
      role: "member" as const,
      isBillingAdmin: false,
      canManageBilling: false,
      planKey: "team",
    };
    const markup = renderToStaticMarkup(
      createElement(UserAuthFooter, {
        account: accountState({
          workspaces: {
            personal,
            team,
            activeWorkspace: { id: team.id, type: "team" },
            hasMembershipConflict: false,
          },
        }),
        onSelectWorkspace: async () => undefined,
        onOpenSettings: () => undefined,
      }),
    );

    expect(markup).toContain('class="user-auth-team-badge"');
    expect(markup).toContain("Analytical Engine");
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
      label: "Sign in",
      image: null,
    });
  });
});
