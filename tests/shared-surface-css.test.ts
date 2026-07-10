import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function source(relativePath: string): Promise<string> {
  return Bun.file(new URL(relativePath, root)).text();
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
});
