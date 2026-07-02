import { describe, expect, test } from "bun:test";

import {
  runCliCommand,
  getCliCommandDefinition,
  listCliCommandDefinitions,
} from "../src/cli/command-registry";
import type { Command } from "../src/cli/common";

describe("CLI command registry", () => {
  test("registers every command with usage, option schema, and handler metadata", () => {
    const definitions = listCliCommandDefinitions();

    expect(definitions.length).toBeGreaterThan(20);
    for (const definition of definitions) {
      expect(definition.name).toBeTruthy();
      expect(definition.usage).toContain("openpond");
      expect(definition.optionSchema).toBeDefined();
      expect(typeof definition.handler).toBe("function");
    }
  });

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

  test("keeps local profile SDK alias commands registered", () => {
    for (const command of ["inspect", "build", "validate", "eval", "run"] as const) {
      const definition = getCliCommandDefinition(command);

      expect(definition?.name).toBe(command);
      expect(definition?.optionSchema.cwd).toBe("string");
      expect(definition?.optionSchema.json).toBe("boolean");
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
