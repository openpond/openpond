import { describe, expect, test } from "vitest";

import {
  getCliCommandDefinition,
  listCliCommandDefinitions,
  runCliCommand,
} from "../src/cli/command-registry";
import type { Command } from "../src/cli/common";

describe("CLI command registry", () => {

  test("resolves top-level aliases to their canonical command handlers", () => {
    expect(getCliCommandDefinition("organization")?.name).toBe("organizations");
    expect(getCliCommandDefinition("organizations")?.name).toBe("organizations");
    expect(getCliCommandDefinition("interactive")?.name).toBe("tui");
    expect(getCliCommandDefinition("tui")?.name).toBe("tui");
  });

  test("keeps command and alias names unique in the registry", () => {
    const seen = new Set<Command>();

    for (const definition of listCliCommandDefinitions()) {
      for (const name of [definition.name, ...(definition.aliases ?? [])]) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });

  test("prints command usage for aliases without invoking the command handler", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      const handled = await runCliCommand({
        command: "organization",
        options: { help: "true" },
        rest: [],
      });

      expect(handled).toBe(true);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Usage:");
    expect(output).toContain("openpond organizations");
    expect(output).toContain("Aliases:");
    expect(output).toContain("organization");
  });
});
