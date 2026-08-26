import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SidebarProjectItem } from "../../lib/app-models";
import { ProjectsPage } from "./ProjectsPage";

const project = {
  id: "cloud:project-1",
  kind: "cloud",
  pinned: false,
  order: 0,
  project: {
    id: "project-1",
    teamId: "team-1",
    name: "Example project",
    slug: "example-project",
    sourceType: "github_repo",
    sourceLabel: "openpond/example-project",
    defaultBranch: "main",
    internalRepoPath: null,
    manifestPath: null,
    manifestHash: null,
    syncedAt: null,
    organizationName: "Example team",
    organizationSlug: "example-team",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
} as const satisfies SidebarProjectItem;

describe("ProjectsPage", () => {
  it("keeps creation and task controls without import or deletion actions", () => {
    const html = renderToStaticMarkup(
      <ProjectsPage
        accountBaseUrl="https://openpond.ai"
        connection={null}
        onNewCloudProject={() => undefined}
        onNewTask={() => undefined}
        onTogglePinned={() => undefined}
        onUploadLocalProject={() => undefined}
        projects={[project]}
        taskCountByProjectId={{ [project.id]: 2 }}
        teamName="Example team"
      />,
    );

    expect(html).toContain("New cloud project");
    expect(html).toContain("Start a new task in Example project");
    expect(html).not.toContain("Import repository");
    expect(html).not.toContain("Archive Example project");
    expect(html).not.toContain("Remove Example project");
  });
});
