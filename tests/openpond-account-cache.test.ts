import { describe, expect, test } from "vitest";
import type { AccountState } from "@openpond/contracts";
import {
  openPondAccountCacheScope,
  openPondWorkspaceCacheScope,
  preserveCachedAccountIdentities,
} from "../apps/server/src/openpond/server-openpond-cache";

function accountState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    state: "auth_error",
    activeProfile: {
      handle: "qa",
      baseUrl: "https://staging.openpond.ai",
    },
    label: "qa",
    email: null,
    avatarUrl: null,
    environment: "staging",
    baseUrl: "https://staging.openpond.ai",
    apiBaseUrl: "https://api-new.staging-api.openpond.ai",
    chatApiBaseUrl: "https://api-new.staging-api.openpond.ai/opchat/v1",
    creditsLabel: null,
    profile: null,
    products: [],
    workspaces: null,
    apiHealth: null,
    accounts: [],
    error: "Unauthorized",
    ...overrides,
  };
}

describe("preserveCachedAccountIdentities", () => {
  test("keeps account discovery stable while partitioning workspace caches", () => {
    const personal = accountState({
      state: "signed_in",
      profile: { id: "user_qa" } as AccountState["profile"],
      workspaces: {
        activeWorkspace: { id: "personal_qa", type: "personal" },
      } as AccountState["workspaces"],
    });
    const team = accountState({
      ...personal,
      workspaces: {
        activeWorkspace: { id: "team_engine", type: "team" },
      } as AccountState["workspaces"],
    });

    expect(openPondAccountCacheScope(personal)).toBe(
      openPondAccountCacheScope(team),
    );
    expect(openPondWorkspaceCacheScope(personal)).not.toBe(
      openPondWorkspaceCacheScope(team),
    );
    expect(openPondWorkspaceCacheScope(team)).toContain(
      "profile:user_qa|workspace:team_engine",
    );
  });

  test("retains last-known email and display identity while using fresh auth status", () => {
    const fresh = accountState({
      accounts: [
        {
          handle: "qa",
          baseUrl: "https://staging.openpond.ai",
          apiBaseUrl: "https://api-new.staging-api.openpond.ai",
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
