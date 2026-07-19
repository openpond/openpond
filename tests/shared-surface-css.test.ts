import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), "utf8");
}

describe("shared surface stylesheet ownership", () => {
  test("loads top-bar Insights styles with the eagerly rendered top bar", async () => {
    const [component, shellCss, featureCss] = await Promise.all([
      source("apps/web/src/components/app-shell/AppTopBar.tsx"),
      source("apps/web/src/styles/app-shell/topbar-insights.css"),
      source("apps/web/src/styles/insights/insights.css"),
    ]);

    expect(component).toContain('import "../../styles/app-shell/topbar-insights.css"');
    expect(shellCss).toContain(".topbar-insights-dropdown");
    expect(shellCss).toContain("visibility: hidden");
    expect(featureCss).not.toContain(".topbar-insights-dropdown");
  });

  test("loads dialog styles with the account endpoint dialog", async () => {
    const [component, dialogCss] = await Promise.all([
      source("apps/web/src/components/settings/AccountEndpointDialog.tsx"),
      source("apps/web/src/styles/workspace/git-dialogs.css"),
    ]);

    expect(component).toContain('import "../../styles/workspace/git-dialogs.css"');
    expect(dialogCss).toContain(".git-dialog-backdrop");
    expect(dialogCss).toContain(".git-dialog {");
  });

  test("loads dialog styles with Profile controls outside Settings", async () => {
    const component = await source("apps/web/src/components/settings/ProfileSettingsSection.tsx");
    expect(component).toContain('import "../../styles/workspace/git-dialogs.css"');
  });

  test("loads Team row styles with the eagerly rendered sidebar", async () => {
    const [component, sidebarCss, featureCss] = await Promise.all([
      source("apps/web/src/components/sidebar/SidebarTeamSection.tsx"),
      source("apps/web/src/styles/sidebar/team-sidebar.css"),
      source("apps/web/src/styles/team-chat/team-chat.css"),
    ]);

    expect(component).toContain('import "../../styles/sidebar/team-sidebar.css"');
    expect(component).toContain('label="general"');
    expect(component).not.toContain('label="# general"');
    expect(sidebarCss).toContain(".team-sidebar-row {");
    expect(sidebarCss).toContain("background: transparent");
    expect(featureCss).not.toContain(".team-sidebar-row");
    expect(featureCss).not.toContain(".team-sidebar-avatar");
  });
});
