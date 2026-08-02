import { describe, expect, test } from "vitest";

import {
  normalizeOpenPondOrganization,
  resolveActiveTeamChatOpenPondOrganization,
  resolveDefaultOpenPondOrganization,
  resolveTeamChatOpenPondOrganization,
} from "../apps/web/src/lib/cloud-project-utils";
import type { OpenPondOrganization } from "../apps/web/src/lib/organization-types";

function organization(
  teamId: string,
  overrides: Partial<OpenPondOrganization> = {},
): OpenPondOrganization {
  return {
    teamId,
    slug: teamId,
    name: teamId,
    displayName: teamId,
    role: "owner",
    status: "active",
    primaryContactEmail: null,
    customDomain: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("OpenPond default organization selection", () => {
  test("prefers the account personal default team over response order", () => {
    const newTeam = organization("team_new", {
      displayName: "New team",
      kind: "team",
    });
    const defaultTeam = organization("team_default", {
      displayName: "My Organization",
      isPersonalDefault: true,
      kind: "personal_default",
      name: "default",
    });

    expect(resolveDefaultOpenPondOrganization([newTeam, defaultTeam])).toBe(defaultTeam);
  });

  test("preserves default-team metadata while normalizing API responses", () => {
    const normalized = normalizeOpenPondOrganization(
      organization("team_default", {
        isPersonalDefault: true,
        kind: "personal_default",
      }),
    );

    expect(normalized?.isPersonalDefault).toBe(true);
    expect(normalized?.kind).toBe("personal_default");
  });

  test("preserves workspace billing context for desktop team surfaces", () => {
    const normalized = normalizeOpenPondOrganization(
      organization("team_shared", {
        workspaceKind: "shared",
        role: "member",
        planKey: "pro",
        effectiveAccessState: "grace",
        canManageBilling: false,
      }),
    );

    expect(normalized).toMatchObject({
      planKey: "pro",
      effectiveAccessState: "grace",
      canManageBilling: false,
    });
  });

  test("recognizes the current API personal workspace name without metadata", () => {
    const normalized = normalizeOpenPondOrganization(
      organization("team_personal", {
        name: "personal",
        workspaceKind: undefined,
        kind: undefined,
        isPersonalDefault: undefined,
      }),
    );

    expect(normalized?.workspaceKind).toBe("personal");
    expect(normalized?.isPersonalDefault).toBe(true);
  });

  test("selects the shared team for chat when the default workspace is personal", () => {
    const personal = organization("team_personal", {
      workspaceKind: "personal",
      kind: "personal_default",
      isPersonalDefault: true,
    });
    const shared = organization("team_shared", {
      workspaceKind: "shared",
      kind: "team",
      role: "member",
    });

    expect(resolveTeamChatOpenPondOrganization([personal, shared], personal.teamId)).toBe(shared);
  });

  test("honors a preferred shared team and otherwise prefers an owned team", () => {
    const memberTeam = organization("team_member", {
      workspaceKind: "shared",
      role: "member",
    });
    const ownedTeam = organization("team_owned", {
      workspaceKind: "shared",
      role: "owner",
    });

    expect(resolveTeamChatOpenPondOrganization([memberTeam, ownedTeam], memberTeam.teamId)).toBe(
      memberTeam,
    );
    expect(resolveTeamChatOpenPondOrganization([memberTeam, ownedTeam], null)).toBe(ownedTeam);
  });

  test("enables Team Chat only for the canonical active Team workspace", () => {
    const shared = organization("team_shared", {
      workspaceKind: "shared",
      kind: "team",
      role: "member",
    });
    const personalWorkspace = {
      personal: {
        id: "personal_ada",
        type: "personal" as const,
        displayName: "Personal",
        role: "owner" as const,
        isBillingAdmin: true,
        canManageBilling: true,
        planKey: "free",
        accessState: "active",
        usage: {
          scope: "member" as const,
          limitsScope: "member" as const,
          periodStart: "2026-08-01T00:00:00.000Z",
          sandbox: { hours: 0, retailUsd: null, includedHours: 0, maxConcurrent: 1 },
          opChat: { tokens: 0, includedTokens: 0 },
          search: { calls: 0, includedCalls: 0 },
          personalizedInference: { requests: 0, includedRequests: 0 },
          totalRetailUsd: null,
        },
      },
      team: null,
      activeWorkspace: { id: "personal_ada", type: "personal" as const },
      hasMembershipConflict: false,
    };

    expect(resolveActiveTeamChatOpenPondOrganization([shared], personalWorkspace)).toBeNull();
    expect(
      resolveActiveTeamChatOpenPondOrganization([shared], {
        ...personalWorkspace,
        team: { ...personalWorkspace.personal, id: shared.teamId, type: "team" },
        activeWorkspace: { id: shared.teamId, type: "team" },
      }),
    ).toBe(shared);
  });
});
