import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPOSER_SLASH_COMMANDS, parseComposerSlashCommandPrompt } from "../apps/web/src/lib/composer-slash-commands";
import { ComposerSlashMenu } from "../apps/web/src/components/chat/ComposerSlashMenu";

describe("/train command", () => {
  test("uses the typed slash catalog", () => {
    expect(COMPOSER_SLASH_COMMANDS.find((item) => item.id === "train")).toMatchObject({ command: "/train", label: "Create training task" });
    expect(parseComposerSlashCommandPrompt("/train")).toEqual({ command: "train", args: "" });
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
