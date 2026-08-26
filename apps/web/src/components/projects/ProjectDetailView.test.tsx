import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SidebarProjectItem } from "../../lib/app-models";
import { ProjectDetailView } from "./ProjectDetailView";

const cloudProject: Extract<SidebarProjectItem, { kind: "cloud" }> = {
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
    syncedAt: "2026-08-25T12:00:00.000Z",
    organizationName: "Example team",
    organizationSlug: "example-team",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
};

describe("ProjectDetailView", () => {
  it("opens as a hosted-style project workspace rather than a chat", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        accountBaseUrl="https://openpond.ai"
        connection={null}
        onBack={() => undefined}
        onNewTask={() => undefined}
        onTogglePinned={() => undefined}
        onUploadLocalProject={() => undefined}
        project={cloudProject}
        taskCount={3}
        teamName="Example team"
      />,
    );

    expect(html).toContain("Example project");
    expect(html).toContain("Source");
    expect(html).toContain("Project Actions");
    expect(html).toContain("Environments");
    expect(html).toContain("Deployments");
    expect(html).toContain("Requests");
    expect(html).toContain("Website");
    expect(html).toContain("github.com/openpond/example-project");
    expect(html).toContain("New task");
    expect(html).not.toContain("Archive project");
    expect(html).not.toContain("Remove project");
    expect(html).not.toContain("Go to chat");
  });
});
