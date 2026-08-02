import { describe, expect, test } from "vitest";
import { OpenPondApiError } from "@openpond/cloud/api/core";
import type { AccountState } from "@openpond/contracts";
import {
  openPondAccountCacheScope,
  openPondWorkspaceCacheScope,
  preserveCachedAccountIdentities,
  shouldPreserveCachedAccountOnRefresh,
} from "../apps/server/src/openpond/server-openpond-cache";
import { isOpenPondAuthenticationError } from "../packages/runtime/src/apps";

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

describe("account refresh failure handling", () => {
  const cachedTeam = accountState({
    state: "signed_in",
    error: null,
    profile: { id: "user_qa" } as AccountState["profile"],
    workspaces: {
      activeWorkspace: { id: "team_engine", type: "team" },
    } as AccountState["workspaces"],
  });

  test("keeps the last valid Team projection during a transient network failure", () => {
    const failedRefresh = accountState({
      state: "signed_in",
      error: "Account lookup failed: network unavailable",
      workspaces: null,
    });

    expect(
      shouldPreserveCachedAccountOnRefresh(failedRefresh, cachedTeam),
    ).toBe(true);
  });

  test("does not preserve Team state after authentication failure or Personal fallback", () => {
    const authFailure = accountState({
      state: "auth_error",
      error: "Account lookup failed: 401 Unauthorized",
      workspaces: null,
    });
    const personalFallback = accountState({
      state: "signed_in",
      error: null,
      workspaces: {
        activeWorkspace: { id: "personal_qa", type: "personal" },
      } as AccountState["workspaces"],
    });

    expect(
      shouldPreserveCachedAccountOnRefresh(authFailure, cachedTeam),
    ).toBe(false);
    expect(
      shouldPreserveCachedAccountOnRefresh(personalFallback, cachedTeam),
    ).toBe(false);
  });

  test("classifies only 401 and 403 API responses as authentication failures", () => {
    expect(
      isOpenPondAuthenticationError(
        new OpenPondApiError(401, "UNAUTHORIZED", "Account lookup"),
      ),
    ).toBe(true);
    expect(
      isOpenPondAuthenticationError(
        new OpenPondApiError(403, "FORBIDDEN", "Account lookup"),
      ),
    ).toBe(true);
    expect(
      isOpenPondAuthenticationError(
        new OpenPondApiError(500, "INTERNAL", "Account lookup"),
      ),
    ).toBe(false);
    expect(isOpenPondAuthenticationError(new Error("offline"))).toBe(false);
  });
});
