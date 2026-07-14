import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactArchitectureLabel,
  unpackedPackageCandidates,
} from "../scripts/check-desktop-package-budgets";
import { runtimeInventoryVerification } from "../scripts/desktop-runtime-inventory";
import { assertStandaloneDesktopBundle, nodePtyPrebuildFiles } from "../scripts/stage-desktop-runtime";

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
    expect(config.extraResources).toContainEqual({ from: "LICENSE", to: "LICENSE.openpond.txt" });
    expect(JSON.stringify(config.extraResources)).not.toContain("node_modules/sqlite3");
    expect(JSON.stringify(config.extraResources)).not.toContain("node_modules/node-pty");
  });

  test("selects architecture-specific electron-builder output directories", () => {
    expect(unpackedPackageCandidates("/release", "linux", "arm64")[0]).toBe("/release/linux-arm64-unpacked");
    expect(unpackedPackageCandidates("/release", "linux", "x64")[0]).toBe("/release/linux-unpacked");
    expect(unpackedPackageCandidates("/release", "darwin", "arm64")[0]).toBe("/release/mac-arm64");
    expect(unpackedPackageCandidates("/release", "darwin", "x64")[0]).toBe("/release/mac");
    expect(artifactArchitectureLabel("linux", "x64")).toBe("x86_64");
    expect(artifactArchitectureLabel("linux", "arm64")).toBe("arm64");
    expect(artifactArchitectureLabel("darwin", "x64")).toBe("x64");
  });

  test("uses signature-aware verification only for Darwin executable runtime files", () => {
    expect(runtimeInventoryVerification("darwin", "server/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"))
      .toBe("darwin-code-signature");
    expect(runtimeInventoryVerification("darwin", "server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"))
      .toBe("darwin-code-signature");
    expect(runtimeInventoryVerification("darwin", "server/index.js")).toBe("sha256");
    expect(runtimeInventoryVerification("linux", "server/node_modules/node-pty/prebuilds/linux-arm64/pty.node"))
      .toBe("sha256");
  });

  test("rejects unbundled desktop entrypoints before staging", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-bundle-"));
    try {
      const bundled = path.join(dir, "bundled.js");
      const unbundled = path.join(dir, "unbundled.js");
      await writeFile(bundled, 'import { app } from "electron"; console.log(app.name);\n');
      await writeFile(unbundled, 'import { helper } from "./helper.js"; console.log(helper);\n');
      await expect(assertStandaloneDesktopBundle(bundled)).resolves.toBeUndefined();
      await expect(assertStandaloneDesktopBundle(unbundled)).rejects.toThrow("Run bun run build:desktop");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
