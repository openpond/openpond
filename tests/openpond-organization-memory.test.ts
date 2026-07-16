import { describe, expect, test } from "vitest";

import {
  preloadOpenPondOrganizations,
  readOpenPondOrganizationsFromMemory,
} from "../apps/web/src/lib/openpond-organization-memory";
import type { OpenPondOrganization } from "../apps/web/src/lib/organization-types";

function organization(
  teamId: string,
  workspaceKind: "personal" | "shared",
): OpenPondOrganization {
  return {
    teamId,
    slug: teamId,
    name: teamId,
    displayName: teamId,
    role: workspaceKind === "personal" ? "owner" : "member",
    workspaceKind,
    status: "active",
    primaryContactEmail: null,
    customDomain: null,
    createdAt: "",
    updatedAt: "",
  };
}

describe("OpenPond organization memory", () => {
  test("force refresh replaces a stale personal-only membership snapshot", async () => {
    const accountKey = `organization-memory-${Date.now()}`;
    const personal = organization("team_personal", "personal");
    const shared = organization("team_shared", "shared");
    let fetchCount = 0;

    await preloadOpenPondOrganizations({
      accountKey,
      fetchOrganizations: async () => {
        fetchCount += 1;
        return [personal];
      },
    });
    const cached = await preloadOpenPondOrganizations({
      accountKey,
      fetchOrganizations: async () => {
        fetchCount += 1;
        return [personal, shared];
      },
    });
    const refreshed = await preloadOpenPondOrganizations({
      accountKey,
      force: true,
      fetchOrganizations: async () => {
        fetchCount += 1;
        return [personal, shared];
      },
    });

    expect(cached).toEqual([personal]);
    expect(refreshed).toEqual([personal, shared]);
    expect(readOpenPondOrganizationsFromMemory(accountKey)).toEqual([
      personal,
      shared,
    ]);
    expect(fetchCount).toBe(2);
  });
});
