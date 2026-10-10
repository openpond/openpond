import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import {
  artifactArchitectureLabel,
  unpackedPackageCandidates
} from "../scripts/check-desktop-package";
import { runtimeInventoryVerification } from "../scripts/desktop-runtime-inventory";
import {
  assertStandaloneDesktopBundle,
  nodePtyPrebuildFiles,
  stageDesktopRuntime,
} from "../scripts/stage-desktop-runtime";

describe("desktop runtime staging", () => {
  // Failure story: small PNG-based ICNS entries disappeared in Finder while a
  // full-bleed runtime override made the Dock icon larger than neighboring apps.
  // Decode the shipped assets, including small ARGB entries and Retina sizes.
  test("ships padded macOS icons with decodable Finder and Retina representations", async () => {
    const build = fileURLToPath(new URL("../apps/desktop/build/", import.meta.url));
    const icns = await readFile(path.join(build, "icon.icns"));
    const dockPng = await readFile(path.join(build, "icon-mac.png"));
    expect(icns.toString("ascii", 0, 4)).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const expected = new Map([
      ["ic04", 16], ["ic05", 32], ["ic07", 128], ["ic08", 256], ["ic09", 512],
      ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
    ]);
    for (let offset = 8; offset < icns.length;) {
      const type = icns.toString("ascii", offset, offset + 4);
      const length = icns.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThan(8);
      expect(offset + length).toBeLessThanOrEqual(icns.length);
      const size = expected.get(type);
      expect(size, `Unexpected or duplicate ICNS entry ${type}`).toBeDefined();
      expected.delete(type);
      const payload = icns.subarray(offset + 8, offset + length);
      let image: PNG;
      if (type === "ic04" || type === "ic05") {
        expect(payload.toString("ascii", 0, 4)).toBe("ARGB");
        image = new PNG({ width: size!, height: size! });
        let cursor = 4;
        for (const channel of [3, 0, 1, 2]) {
          let pixel = 0;
          while (pixel < size! * size!) {
            expect(cursor).toBeLessThan(payload.length);
            const control = payload[cursor++]!;
            const count = control < 128 ? control + 1 : control - 125;
            expect(pixel + count).toBeLessThanOrEqual(size! * size!);
            const repeated = control >= 128 ? payload[cursor++] : undefined;
            for (let index = 0; index < count; index++) {
              const value = repeated ?? payload[cursor++];
              expect(value).toBeDefined();
              image.data[pixel++ * 4 + channel] = value!;
            }
          }
        }
        expect(cursor).toBe(payload.length);
      } else {
        image = PNG.sync.read(payload);
      }
      expect([image.width, image.height]).toEqual([size, size]);
      const inset = Math.round(size! * 96 / 1024);
      let hasVisibleLogo = false;
      for (let y = 0; y < size!; y++) {
        for (let x = 0; x < size!; x++) {
          const pixel = (y * size! + x) * 4;
          if (x < inset || y < inset || x >= size! - inset || y >= size! - inset) {
            if (image.data[pixel + 3] !== 0) throw new Error(`${type} is missing transparent macOS padding.`);
          }
          if (image.data[pixel] > 128 && image.data[pixel + 3] > 128) hasVisibleLogo = true;
        }
      }
      expect(hasVisibleLogo, `${type} has no visible logo`).toBe(true);
      if (type === "ic09") expect(payload.equals(dockPng)).toBe(true);
      offset += length;
    }
    expect(expected.size).toBe(0);
  });

  test("selects only runtime node-pty files for each target", () => {
    expect(nodePtyPrebuildFiles("linux")).toEqual(["pty.node"]);
    expect(nodePtyPrebuildFiles("darwin")).toEqual([
      "pty.node",
      "spawn-helper",
    ]);
    expect(nodePtyPrebuildFiles("win32")).toEqual([
      "pty.node",
      "conpty.node",
      "conpty_console_list.node",
      "winpty-agent.exe",
      "winpty.dll",
    ]);
    expect(
      nodePtyPrebuildFiles("win32").some((file) => file.endsWith(".pdb"))
    ).toBe(false);
  });

  test("stages node-pty from the server workspace without root hoisting", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "openpond-desktop-pnpm-stage-")
    );
    try {
      await Promise.all([
        writeFixture(
          root,
          "package.json",
          '{"version":"0.0.30-bootstrap.0"}\n'
        ),
        writeFixture(
          root,
          "apps/desktop/dist/main.js",
          'import { app } from "electron"; void app;\n'
        ),
        writeFixture(
          root,
          "apps/desktop/dist/preload.js",
          'console.log("preload");\n'
        ),
        writeFixture(
          root,
          "apps/server/dist/index.js",
          'console.log("server");\n'
        ),
        writeFixture(
          root,
          "apps/cli/dist/cli.js",
          'import "./chunks/collector.js";\n'
        ),
        writeFixture(
          root,
          "apps/cli/dist/chunks/collector.js",
          'console.log("collector");\n'
        ),
        writeFixture(root, "apps/cli/build/cli-runtime-outputs.json", JSON.stringify(["dist/cli.js", "dist/chunks/collector.js"])),
        // Retired transport code left by an earlier hash must never ship.
        writeFixture(root, "apps/cli/dist/chunks/retired-poll-executor.js", 'throw new Error("obsolete transport");\n'),
        writeFixture(
          root,
          "apps/web/dist/index.html",
          "<main>OpenPond</main>\n"
        ),
        writeFixture(
          root,
          "apps/cli/skills/openpond-taskset-authoring/SKILL.md",
          "# Tasksets\n"
        ),
        writeFixture(
          root,
          "apps/cli/skills/openpond-skill-authoring/SKILL.md",
          "# Skill authoring\n"
        ),
        writeFixture(
          root,
          "apps/cli/skills/openpond-agent-authoring/SKILL.md",
          "# Agent authoring\n"
        ),
        writeFixture(
          root,
          "packages/agent-sdk/package.json",
          '{"name":"openpond-agent-sdk","version":"0.0.0","private":true,"files":["dist"]}\n'
        ),
        writeFixture(
          root,
          "packages/agent-sdk/dist/cli.js",
          "#!/usr/bin/env node\n"
        ),
        writeFixture(
          root,
          "apps/server/node_modules/node-pty/package.json",
          '{"name":"node-pty","version":"1.1.0","main":"./lib/index.js"}\n'
        ),
        writeFixture(
          root,
          "apps/server/node_modules/node-pty/LICENSE",
          "MIT\n"
        ),
        writeFixture(
          root,
          "apps/server/node_modules/node-pty/lib/index.js",
          "module.exports = {};\n"
        ),
        writeFixture(
          root,
          "apps/server/node_modules/node-pty/prebuilds/linux-x64/pty.node",
          "native"
        ),
      ]);

      const result = await stageDesktopRuntime({
        root,
        platform: "linux",
        arch: "x64",
      });
      const stagedPaths = result.files.map((entry) => entry.path);

      expect(await readFile(path.join(result.stageRoot, "runtime/cli/cli.js"), "utf8"))
        .toBe('import "./chunks/collector.js";\n');
      expect(await readFile(path.join(result.stageRoot, "runtime/cli/chunks/collector.js"), "utf8"))
        .toBe('console.log("collector");\n');
      expect(stagedPaths).not.toContain("cli/chunks/retired-poll-executor.js");

      expect(stagedPaths).toContain(
        "server/node_modules/node-pty/package.json"
      );
      expect(stagedPaths).toContain(
        "server/node_modules/node-pty/prebuilds/linux-x64/pty.node"
      );
      expect(stagedPaths).toContain(
        "server/skills/openpond-skill-authoring/SKILL.md"
      );
      expect(stagedPaths).toContain(
        "server/skills/openpond-agent-authoring/SKILL.md"
      );
      expect(stagedPaths).toContain(
        "server/work-assets/openpond-agent-sdk.tgz"
      );
      expect(
        stagedPaths.some((entry) => entry.endsWith("/agents/openai.yaml"))
      ).toBe(false);
      expect(stagedPaths.some((entry) => entry.includes("/bindings/"))).toBe(
        false
      );
      expect(
        stagedPaths.some((entry) => entry.includes("file-uri-to-path"))
      ).toBe(false);
      await expect(
        readFile(
          path.join(root, "node_modules", "node-pty", "package.json"),
          "utf8"
        )
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("electron-builder consumes only the staged app and runtime", async () => {
    const config = JSON.parse(
      await readFile(
        path.join(
          import.meta.dirname,
          "..",
          "apps",
          "desktop",
          "electron-builder.json"
        ),
        "utf8"
      )
    ) as {
      directories?: { app?: string };
      files?: string[];
      extraResources?: Array<{ from?: string }>;
      npmRebuild?: boolean;
      artifactName?: string;
      mac?: {
        identity?: string;
        forceCodeSigning?: boolean;
        hardenedRuntime?: boolean;
        entitlements?: string;
        entitlementsInherit?: string;
        notarize?: boolean;
      };
    };

    expect(config.directories?.app).toBe("apps/desktop/stage/app");
    expect(config.artifactName).toBe("openpond-${version}-${os}-${arch}.${ext}");
    expect(config.npmRebuild).toBe(false);
    expect(config.mac?.identity).toBeUndefined();
    expect(config.mac?.forceCodeSigning).toBe(true);
    expect(config.mac?.hardenedRuntime).toBe(true);
    expect(config.mac?.entitlements).toBe(
      "apps/desktop/build/entitlements.mac.plist"
    );
    expect(config.mac?.entitlementsInherit).toBe(
      "apps/desktop/build/entitlements.mac.inherit.plist"
    );
    expect(config.mac?.notarize).toBe(true);
    expect((config as { linux?: { syncDesktopName?: boolean } }).linux?.syncDesktopName).toBe(true);
    expect(config.files).toContain("!node_modules/**/*");
    expect(config.extraResources?.map((entry) => entry.from)).toContain(
      "apps/desktop/stage/runtime"
    );
    expect(config.extraResources).toContainEqual({
      from: "LICENSE",
      to: "LICENSE.openpond.txt",
    });
    expect(JSON.stringify(config.extraResources)).not.toContain(
      "node_modules/sqlite3"
    );
    expect(JSON.stringify(config.extraResources)).not.toContain(
      "node_modules/node-pty"
    );
  });

  test("selects architecture-specific electron-builder output directories", () => {
    expect(unpackedPackageCandidates("/release", "linux", "arm64")[0]).toBe(
      "/release/linux-arm64-unpacked"
    );
    expect(unpackedPackageCandidates("/release", "linux", "x64")[0]).toBe(
      "/release/linux-unpacked"
    );
    expect(unpackedPackageCandidates("/release", "darwin", "arm64")[0]).toBe(
      "/release/mac-arm64"
    );
    expect(unpackedPackageCandidates("/release", "darwin", "x64")[0]).toBe(
      "/release/mac"
    );
    expect(artifactArchitectureLabel("linux", "x64")).toBe("x86_64");
    expect(artifactArchitectureLabel("linux", "arm64")).toBe("arm64");
    expect(artifactArchitectureLabel("darwin", "x64")).toBe("x64");
  });

  test("uses signature-aware verification only for Darwin executable runtime files", () => {
    expect(
      runtimeInventoryVerification(
        "darwin",
        "server/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"
      )
    ).toBe("darwin-code-signature");
    expect(
      runtimeInventoryVerification(
        "darwin",
        "server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
      )
    ).toBe("darwin-code-signature");
    expect(runtimeInventoryVerification("darwin", "server/index.js")).toBe(
      "sha256"
    );
    expect(
      runtimeInventoryVerification(
        "linux",
        "server/node_modules/node-pty/prebuilds/linux-arm64/pty.node"
      )
    ).toBe("sha256");
  });

  test("rejects unbundled desktop entrypoints before staging", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "openpond-desktop-bundle-")
    );
    try {
      const bundled = path.join(dir, "bundled.js");
      const unbundled = path.join(dir, "unbundled.js");
      await writeFile(
        bundled,
        'import { app } from "electron"; console.log(app.name);\n'
      );
      await writeFile(
        unbundled,
        'import { helper } from "./helper.js"; console.log(helper);\n'
      );
      await expect(
        assertStandaloneDesktopBundle(bundled)
      ).resolves.toBeUndefined();
      await expect(assertStandaloneDesktopBundle(unbundled)).rejects.toThrow(
        "Run pnpm run build:desktop"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeFixture(
  root: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}
