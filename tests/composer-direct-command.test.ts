import { describe, expect, test } from "bun:test";

import {
  parseComposerDirectCommandPrompt,
  parseComposerSlashCommandPrompt,
} from "../apps/web/src/lib/composer-slash-commands";

describe("composer direct command parser", () => {
  test("parses command-only prompts that start with bang", () => {
    expect(parseComposerDirectCommandPrompt("!pwd")).toEqual({ command: "pwd" });
    expect(parseComposerDirectCommandPrompt("  !  bun test tests/openpond-command-access.test.ts  ")).toEqual({
      command: "bun test tests/openpond-command-access.test.ts",
    });
  });

  test("leaves empty bang and slash commands out of the direct-command path", () => {
    expect(parseComposerDirectCommandPrompt("!   ")).toBeNull();
    expect(parseComposerDirectCommandPrompt("/create agent")).toBeNull();
    expect(parseComposerSlashCommandPrompt("!pwd")).toBeNull();
  });
});
