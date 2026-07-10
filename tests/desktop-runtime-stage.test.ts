import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { nodePtyPrebuildFiles } from "../scripts/stage-desktop-runtime";

describe("desktop runtime staging", () => {
  test("selects only runtime node-pty files for each target", () => {
    expect(nodePtyPrebuildFiles("linux")).toEqual(["pty.node"]);
    expect(nodePtyPrebuildFiles("darwin")).toEqual(["pty.node", "spawn-helper"]);
    expect(nodePtyPrebuildFiles("win32")).toEqual([
      "pty.node",
      "conpty.node",
      "conpty_console_list.node",
      "winpty-agent.exe",
      "winpty.dll",
    ]);
    expect(nodePtyPrebuildFiles("win32").some((file) => file.endsWith(".pdb"))).toBe(false);
  });

  test("electron-builder consumes only the staged app and runtime", async () => {
    const config = JSON.parse(
      await readFile(path.join(import.meta.dir, "..", "apps", "desktop", "electron-builder.json"), "utf8"),
    ) as {
      directories?: { app?: string };
      files?: string[];
      extraResources?: Array<{ from?: string }>;
      npmRebuild?: boolean;
    };

    expect(config.directories?.app).toBe("apps/desktop/stage/app");
    expect(config.npmRebuild).toBe(false);
    expect(config.files).toContain("!node_modules/**/*");
    expect(config.extraResources?.map((entry) => entry.from)).toContain("apps/desktop/stage/runtime");
    expect(JSON.stringify(config.extraResources)).not.toContain("node_modules/sqlite3");
    expect(JSON.stringify(config.extraResources)).not.toContain("node_modules/node-pty");
  });
});
