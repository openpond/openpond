import { describe, expect, test } from "vitest";
import type { AccountState } from "@openpond/contracts";

import {
  activeOpenPondWorkspaceId,
  openPondAccountScopeKey,
  openPondAccountWorkspaceScopeKey,
} from "../apps/web/src/lib/account-scope";
import { openPondOrganizationCacheKey } from "../apps/web/src/lib/openpond-organization-memory";

function account(activeWorkspaceId: string): AccountState {
  return {
    state: "signed_in",
    activeProfile: { handle: "ada", baseUrl: "https://openpond.ai" },
    label: "Ada",
    email: "ada@example.com",
    avatarUrl: null,
    environment: "production",
    baseUrl: "https://openpond.ai",
    apiBaseUrl: "https://api.openpond.ai",
    chatApiBaseUrl: "https://opchat.openpond.ai",
    creditsLabel: null,
    profile: { id: "user_ada" } as AccountState["profile"],
    products: [],
    workspaces: {
      personal: { id: "personal_ada" } as NonNullable<
        AccountState["workspaces"]
      >["personal"],
      team: { id: "team_engine" } as NonNullable<
        AccountState["workspaces"]
      >["team"],
      activeWorkspace: {
        id: activeWorkspaceId,
        type: activeWorkspaceId === "personal_ada" ? "personal" : "team",
      },
      hasMembershipConflict: false,
    },
    apiHealth: null,
    accounts: [],
    error: null,
  };
}

describe("OpenPond account/workspace scope", () => {
  test("keeps stable account identity while partitioning workspace caches", () => {
    const personal = account("personal_ada");
    const team = account("team_engine");

    expect(openPondAccountScopeKey(personal)).toBe(
      openPondAccountScopeKey(team),
    );
    expect(activeOpenPondWorkspaceId(personal)).toBe("personal_ada");
    expect(activeOpenPondWorkspaceId(team)).toBe("team_engine");
    expect(openPondAccountWorkspaceScopeKey(personal)).not.toBe(
      openPondAccountWorkspaceScopeKey(team),
    );
    expect(openPondOrganizationCacheKey(personal)).toBe(
      openPondAccountWorkspaceScopeKey(personal),
    );
  });
});
