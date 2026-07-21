import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactArchitectureLabel,
  desktopPackageBudget,
  unpackedPackageCandidates,
} from "../scripts/check-desktop-package-budgets";
import { runtimeInventoryVerification } from "../scripts/desktop-runtime-inventory";
import {
  assertStandaloneDesktopBundle,
  nodePtyPrebuildFiles,
  stageDesktopRuntime,
} from "../scripts/stage-desktop-runtime";

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

  test("stages node-pty from the server workspace without root hoisting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-pnpm-stage-"));
    try {
      await Promise.all([
        writeFixture(root, "package.json", '{"version":"0.0.30-bootstrap.0"}\n'),
        writeFixture(root, "apps/desktop/dist/main.js", 'import { app } from "electron"; void app;\n'),
        writeFixture(root, "apps/desktop/dist/preload.js", 'console.log("preload");\n'),
        writeFixture(root, "apps/server/dist/index.js", 'console.log("server");\n'),
        writeFixture(root, "apps/web/dist/index.html", "<main>OpenPond</main>\n"),
        writeFixture(root, "apps/cli/skills/openpond-taskset-authoring/SKILL.md", "# Tasksets\n"),
        writeFixture(
          root,
          "apps/server/node_modules/node-pty/package.json",
          '{"name":"node-pty","version":"1.1.0","main":"./lib/index.js"}\n',
        ),
        writeFixture(root, "apps/server/node_modules/node-pty/LICENSE", "MIT\n"),
        writeFixture(root, "apps/server/node_modules/node-pty/lib/index.js", "module.exports = {};\n"),
        writeFixture(root, "apps/server/node_modules/node-pty/prebuilds/linux-x64/pty.node", "native"),
      ]);

      const result = await stageDesktopRuntime({ root, platform: "linux", arch: "x64" });
      const stagedPaths = result.files.map((entry) => entry.path);

      expect(stagedPaths).toContain("server/node_modules/node-pty/package.json");
      expect(stagedPaths).toContain("server/node_modules/node-pty/prebuilds/linux-x64/pty.node");
      expect(stagedPaths.some((entry) => entry.includes("/bindings/"))).toBe(false);
      expect(stagedPaths.some((entry) => entry.includes("file-uri-to-path"))).toBe(false);
      await expect(readFile(path.join(root, "node_modules", "node-pty", "package.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("electron-builder consumes only the staged app and runtime", async () => {
    const config = JSON.parse(
      await readFile(path.join(import.meta.dirname, "..", "apps", "desktop", "electron-builder.json"), "utf8"),
    ) as {
      directories?: { app?: string };
      files?: string[];
      extraResources?: Array<{ from?: string }>;
      npmRebuild?: boolean;
      mac?: { identity?: string };
    };

    expect(config.directories?.app).toBe("apps/desktop/stage/app");
    expect(config.npmRebuild).toBe(false);
    expect(config.mac?.identity).toBe("-");
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

  test("keeps Linux unpacked package budgets architecture-specific", () => {
    expect(desktopPackageBudget("linux", "x64")?.maxUnpackedBytes).toBe(400 * 1024 * 1024);
    expect(desktopPackageBudget("linux", "arm64")?.maxUnpackedBytes).toBe(334 * 1024 * 1024);
    expect(desktopPackageBudget("darwin", "arm64")?.maxUnpackedBytes).toBe(400 * 1024 * 1024);
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
      await expect(assertStandaloneDesktopBundle(unbundled)).rejects.toThrow("Run pnpm run build:desktop");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}
