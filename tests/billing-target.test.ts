import { describe, expect, test } from "vitest";
import { CloudProjectSchema } from "@openpond/contracts";

import { billingTargetForContext } from "../apps/web/src/components/app-shell/main-pane-helpers";

describe("desktop billing target", () => {
  const unrelatedProject = CloudProjectSchema.parse({
    id: "project_unrelated",
    teamId: "team_other",
    name: "Other",
    organizationSlug: "other",
  });
  const activeTeamProject = CloudProjectSchema.parse({
    id: "project_engine",
    teamId: "team_engine",
    name: "Engine",
    organizationSlug: "engine",
  });

  test("uses the canonical Personal workspace instead of a project fallback", () => {
    expect(
      billingTargetForContext({
        activeAccountWorkspaceId: "personal_ada",
        activeAccountWorkspaceType: "personal",
        cloudProjects: [unrelatedProject],
      }),
    ).toEqual({ organizationSlug: null, teamId: "personal_ada" });
  });

  test("uses only a project belonging to the canonical Team workspace", () => {
    expect(
      billingTargetForContext({
        activeAccountWorkspaceId: "team_engine",
        activeAccountWorkspaceType: "team",
        cloudProjects: [unrelatedProject, activeTeamProject],
      }),
    ).toEqual({ organizationSlug: "engine", teamId: "team_engine" });
  });
});
