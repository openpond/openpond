import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPOSER_SLASH_COMMANDS, parseComposerSlashCommandPrompt } from "../apps/web/src/lib/composer-slash-commands";
import { ComposerSlashMenu } from "../apps/web/src/components/chat/ComposerSlashMenu";
import { readFile } from "node:fs/promises";

describe("/train command", () => {
  test("uses the typed existing slash catalog and opens manual source selection", async () => {
    expect(COMPOSER_SLASH_COMMANDS.find((item) => item.id === "train")).toMatchObject({ command: "/train", label: "Create training task" });
    expect(parseComposerSlashCommandPrompt("/train")).toEqual({ command: "train", args: "" });
    const [mainPane, mainChatThread] = await Promise.all([
      readFile("apps/web/src/components/app-shell/MainPane.tsx", "utf8"),
      readFile("apps/web/src/components/app-shell/MainChatThread.tsx", "utf8"),
    ]);
    expect(mainPane).toContain('command.command === "train"');
    expect(mainPane).toContain("setTrainingLaunchRequest");
    expect(mainPane).toContain("initialSessionIds: [selectedSessionId]");
    expect(mainPane).toContain("TrainingCreationPanel");
    expect(mainChatThread).toContain("TrainingStatusReceipt");
  });

  test("shows /train in the desktop composer slash menu", () => {
    const command = COMPOSER_SLASH_COMMANDS.find((item) => item.id === "train");
    expect(command).toBeDefined();
    const html = renderToStaticMarkup(createElement(ComposerSlashMenu, {
      actionCatalogCount: 0,
      actionIndex: 0,
      items: [{ kind: "command", command: command! }],
      onSelect: () => undefined,
      onSelectIndex: () => undefined,
      style: {},
    }));
    expect(html).toContain("/train Create training task");
    expect(html).toContain("Create a training plan from this chat or select chats in Training.");
  });
});

describe("Agents lazy view styling", () => {
  test("owns the settings styles used by the profile agent surface", async () => {
    const profileView = await readFile("apps/web/src/components/profile/ProfileView.tsx", "utf8");
    const mainPaneStyles = await readFile("apps/web/src/styles/app-shell/main-pane.css", "utf8");
    const settingsListStyles = await readFile("apps/web/src/styles/settings/settings-lists.css", "utf8");
    expect(profileView).toContain('import "../../styles/settings/settings-layout.css"');
    expect(profileView).toContain('import "../../styles/settings/settings-forms.css"');
    expect(profileView).toContain('import "../../styles/settings/settings-lists.css"');
    expect(mainPaneStyles).toContain("container-name: profile-view");
    expect(settingsListStyles).toContain("@container profile-view (max-width: 620px)");
  });
});
