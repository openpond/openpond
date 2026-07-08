import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("dev desktop smoke script", () => {
  test("is wired as a first-class package script", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.["smoke:desktop:dev"]).toBe("bun scripts/smoke-dev-desktop.ts");
  });

  test("prints usage without launching Electron", () => {
    const result = spawnSync(process.execPath, ["scripts/smoke-dev-desktop.ts", "--help"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: bun scripts/smoke-dev-desktop.ts");
  });
});
