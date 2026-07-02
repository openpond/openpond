import { describe, expect, test } from "bun:test";

import {
  buildSandboxOrganizationHref,
  getSandboxOrganizationTeamId,
  normalizeSandboxOrganizationTeamId,
} from "../apps/web/src/lib/sandbox-organization-url";
import { resolveSandboxOrganizationSlug } from "../apps/web/src/lib/sandbox-organization-selection";
import type { OpenPondOrganization } from "../apps/web/src/lib/organization-types";

const organizations: OpenPondOrganization[] = [
  {
    teamId: "team_a",
    name: "alpha",
    displayName: "Alpha",
    slug: "alpha",
    role: "owner",
    status: "active",
    primaryContactEmail: null,
    customDomain: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
  },
  {
    teamId: "team_b",
    name: "beta",
    displayName: "Beta",
    slug: "beta",
    role: "admin",
    status: "active",
    primaryContactEmail: null,
    customDomain: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
  },
];

describe("sandbox organization URL helpers", () => {
  test("normalizes blank team ids", () => {
    expect(normalizeSandboxOrganizationTeamId(null)).toBeNull();
    expect(normalizeSandboxOrganizationTeamId("  ")).toBeNull();
    expect(normalizeSandboxOrganizationTeamId(" team_123 ")).toBe("team_123");
  });

  test("reads selected team from search params", () => {
    expect(getSandboxOrganizationTeamId(new URLSearchParams("teamId=team_123"))).toBe("team_123");
  });

  test("sets selected team while preserving other params", () => {
    expect(
      buildSandboxOrganizationHref({
        currentSearch: "view=templates&teamId=old",
        pathname: "/sandboxes",
        teamId: "team_new",
      }),
    ).toBe("/sandboxes?view=templates&teamId=team_new");
  });

  test("removes selected team when cleared", () => {
    expect(
      buildSandboxOrganizationHref({
        currentSearch: "view=templates&teamId=old",
        pathname: "/sandboxes",
        teamId: null,
      }),
    ).toBe("/sandboxes?view=templates");
  });
});

describe("sandbox organization selection", () => {
  test("keeps an explicit matching slug", () => {
    expect(
      resolveSandboxOrganizationSlug({
        currentSlug: "beta",
        organizations,
        urlTeamId: null,
      }),
    ).toBe("beta");
  });

  test("uses a matching URL team id when no slug is selected", () => {
    expect(
      resolveSandboxOrganizationSlug({
        currentSlug: "",
        organizations,
        urlTeamId: "team_b",
      }),
    ).toBe("beta");
  });

  test("does not fall back to the first organization for multi-team users", () => {
    expect(
      resolveSandboxOrganizationSlug({
        currentSlug: "",
        organizations,
        urlTeamId: null,
      }),
    ).toBe("");
  });

  test("does not fall back to the first organization for invalid selections", () => {
    expect(
      resolveSandboxOrganizationSlug({
        currentSlug: "missing",
        organizations,
        urlTeamId: null,
      }),
    ).toBe("");
    expect(
      resolveSandboxOrganizationSlug({
        currentSlug: "",
        organizations,
        urlTeamId: "missing_team",
      }),
    ).toBe("");
  });

  test("auto-selects the only organization when there is no explicit selection", () => {
    expect(
      resolveSandboxOrganizationSlug({
        currentSlug: "",
        organizations: [organizations[0]],
        urlTeamId: null,
      }),
    ).toBe("alpha");
  });
});
