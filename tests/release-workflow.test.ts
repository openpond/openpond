import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  launchTargetForPath,
  packagedAppCandidates,
} from "../scripts/smoke-packaged-desktop";
import { stageReleaseSourceArtifacts } from "../scripts/stage-release-source-artifacts";
import { validatePackagedSmokeReports } from "../scripts/validate-packaged-smoke-reports";

const WORKFLOW_PATH = ".github/workflows/release-builds.yml";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const CLI_INSTALLER_PATH = "apps/cli/install.sh";
const ROOT_PACKAGE_PATH = "package.json";

describe("release workflow", () => {
  test("CLI installer verifies the published archive checksum before extraction", () => {
    const installer = readFileSync(CLI_INSTALLER_PATH, "utf8");
    expect(installer).toContain('CHECKSUMS_URL="${BASE_URL}/SHA256SUMS.txt"');
    expect(installer).toContain('actual_checksum="$(sha256sum');
    expect(installer).toContain('actual_checksum="$(shasum -a 256');
    expect(installer.indexOf('checksum verification failed')).toBeLessThan(
      installer.indexOf('tar -xzf'),
    );
    expect(installer).toContain('ln -sfn openpond "$INSTALL_DIR/op"');
  });

  test("keeps packaged desktop smoke wired for Linux and macOS release builds while Windows is disabled", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("- name: linux-x64-appimage");
    expect(workflow).toContain("os: ubuntu-24.04");
    expect(workflow).toContain("- name: linux-arm64-appimage");
    expect(workflow).toContain("os: ubuntu-24.04-arm");
    expect(workflow).toContain("package_script: package:linux:release");

    expect(workflow).toContain("- name: mac-arm64-zip");
    expect(workflow).toContain("os: macos-15");
    expect(workflow).toContain("- name: mac-x64-zip");
    expect(workflow).toContain("os: macos-15-intel");
    expect(workflow).toContain("package_script: package:mac:release");

    expect(workflow).toMatch(/#\s*-\s*name:\s*windows-nsis/);
    expect(workflow).not.toMatch(/^\s*-\s*name:\s*windows-nsis$/m);
    expect(workflow).not.toMatch(/^\s*os:\s*windows-latest$/m);
    expect(workflow).not.toMatch(/^\s*package_script:\s*package:win:release$/m);

    expect(workflow).toContain("name: Require green CI");
    expect(workflow).toContain("name: Build release source artifacts once");
    expect(workflow).toContain("name: Verify stable source version");
    expect(workflow).toContain("run: bun run release:version:check -- --version");
    expect(workflow.indexOf("name: Verify stable source version")).toBeLessThan(
      workflow.indexOf("name: Require green CI"),
    );
    expect(workflow.indexOf("name: Verify stable source version")).toBeLessThan(
      workflow.indexOf("name: Build release source artifacts once"),
    );
    expect(workflow).toContain("name: Wait for the required CI check on this commit");
    expect(workflow).toContain('select(.name == "Checks" and .app.slug == "github-actions")');
    expect(workflow.match(/bun run test/g) ?? []).toHaveLength(0);
    expect(workflow).not.toContain("name: Run tests on Windows");
    expect(workflow).not.toContain("bun test tests/*.test.ts");
    expect(workflow.match(/bun run build:artifacts/g)).toHaveLength(1);
    expect(workflow.match(/bun run cli:build/g)).toHaveLength(1);
    expect(workflow).not.toContain("- run: bun run build\n");
    expect(workflow).toContain("name: release-source-artifacts");
    expect(workflow).toContain("name: Stage release source artifacts");
    expect(workflow).toContain("run: bun run release:source-artifacts:stage");
    expect(workflow).toMatch(
      /name: release-source-artifacts\n\s+path: release-source-artifacts\n\s+if-no-files-found: error/,
    );
    expect(workflow).not.toMatch(/path:\s*\|\n(?:\s+(?:apps|packages)\/.+\/dist\n)+/);
    expect(
      workflow.match(
        /actions\/download-artifact@[0-9a-f]{40} # v8\n\s+with:\n\s+name: release-source-artifacts\n\s+path: \./g,
      ),
    ).toHaveLength(2);
    expect(workflow).not.toMatch(
      /name: release-source-artifacts\n\s+path: apps/,
    );

    expect(workflow).toContain("name: Smoke packaged desktop");
    expect(workflow).toContain("name: Prove renderer commit boundaries in the dev browser harness");
    expect(workflow).toContain("dev-render-commits.json");
    expect(workflow).toContain("mkdir -p release-smoke");
    expect(workflow).toContain('report_path="release-smoke/smoke-${{ matrix.name }}.json"');
    expect(workflow).toContain('xvfb-run -a bun run smoke:desktop:packaged -- --json "${report_path}"');
    expect(workflow).toContain('bun run smoke:desktop:packaged -- --json "${report_path}"');
    expect(workflow).toContain("name: packaged-smoke-${{ matrix.name }}");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("path: release-smoke/**");
    expect(workflow).toContain("pattern: packaged-smoke-*");
    expect(workflow).toContain("path: release-smoke-artifacts");
    expect(workflow).toContain("name: Validate packaged smoke reports");
    expect(workflow).toContain("bun run smoke:desktop:packaged:validate -- --dir release-smoke-artifacts");
    expect(workflow).toContain("name: Build and verify native CLI archive");
    expect(workflow).toContain("bun run cli:release:build");
    expect(workflow).toContain("bun scripts/check-cli-distribution.ts --archive \"${cli_archive}\" --skip-npm");
    expect(workflow).toContain("id: npm_publish_auth");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("steps.npm_publish_auth.outputs.enabled == 'true'");
    expect(workflow).toContain("name: Publish stable CLI package to npm");
    expect(workflow).toContain("npm install --global npm@11.5.1\n          npm publish ./apps/cli --access public --provenance --ignore-scripts");
    expect(workflow).toContain("release/*.tar.gz");
    expect(workflow).toContain('basename "${files[$index]}"');
    expect(workflow).toContain("builder-debug.yml");
    expect(workflow).not.toContain("runs-on: ubuntu-latest\n    runs-on: ubuntu-latest");
  });

  test("keeps validation and publishing triggers separated", () => {
    const releaseWorkflow = readFileSync(WORKFLOW_PATH, "utf8");
    const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, "utf8");

    expect(ciWorkflow).toMatch(/push:\n\s+branches:\n\s+- master/);
    expect(ciWorkflow).not.toContain("branches-ignore");
    expect(releaseWorkflow).not.toMatch(/push:\n\s+branches:/);
    expect(releaseWorkflow).toContain('- "!v*-nightly.*"');
    expect(releaseWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'schedule' }}");
    expect(releaseWorkflow).toContain("checks: read");
    expect(ciWorkflow).toContain("name: Checks");
    expect(ciWorkflow).toContain("needs: [quality, unit, integration, contract, release_smoke]");
    expect(ciWorkflow).toContain("bun run test:unit");
    expect(ciWorkflow).toContain("bun run test:integration");
    expect(ciWorkflow).toContain("bun run test:contract");
    expect(ciWorkflow).toContain("bun run test:release");
    expect(ciWorkflow).toMatch(
      /release_smoke:[\s\S]*?actions\/download-artifact@[0-9a-f]{40} # v8[\s\S]*?path: apps/,
    );
    expect(ciWorkflow).not.toContain("OPENPOND_SKIP_CI_LONG_CLI_TESTS");
  });

  test("scopes release credentials to the publishing job and uses current action runtimes", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toMatch(/release:\n[\s\S]*?permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(workflow.match(/contents: write/g)).toHaveLength(1);
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40} # v7/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40} # v6/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v7/);
    expect(workflow).toMatch(/actions\/download-artifact@[0-9a-f]{40} # v8/);
    expect(workflow).toMatch(/softprops\/action-gh-release@[0-9a-f]{40} # v3/);
    expect(workflow).not.toMatch(/^\s*(?:-\s*)?uses:\s+[^\s#]+@v\d+/m);
  });

  test("builds standalone desktop bundles before staging release packages", () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.build).toContain("bun run build:artifacts");
    expect(packageJson.scripts?.["build:artifacts"]).toContain("bun run build:desktop");
  });

  test("keeps the stable release guard available as a package script", () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["release:version:check"]).toBe(
      "bun scripts/check-release-version.ts",
    );
  });

  test("builds server workspace dependencies before bundling release artifacts", () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["bundle:server"]).toMatch(
      /^tsc -b apps\/server && bun build apps\/server\/src\/index\.ts /,
    );
  });

  test("stages every built app and workspace package without a hardcoded package list", async () => {
    const root = await mkdtemp(join(tmpdir(), "openpond-release-source-artifacts-"));
    const outputDirectory = join(root, "release-source-artifacts");
    try {
      await mkdir(join(root, "apps", "server", "dist"), { recursive: true });
      await mkdir(join(root, "packages", "logging", "dist"), { recursive: true });
      await mkdir(join(root, "packages", "source-only", "src"), { recursive: true });
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(root, "apps", "server", "dist", "index.js"), "server");
      await writeFile(join(root, "packages", "logging", "dist", "index.js"), "logging");
      await writeFile(join(root, "packages", "source-only", "src", "index.ts"), "source");
      await writeFile(join(outputDirectory, "stale.txt"), "stale");

      await expect(stageReleaseSourceArtifacts({ root, outputDirectory })).resolves.toEqual([
        "apps/server/dist",
        "packages/logging/dist",
      ]);
      expect(readFileSync(join(outputDirectory, "apps", "server", "dist", "index.js"), "utf8"))
        .toBe("server");
      expect(readFileSync(join(outputDirectory, "packages", "logging", "dist", "index.js"), "utf8"))
        .toBe("logging");
      expect(() => readFileSync(join(outputDirectory, "stale.txt"), "utf8")).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("packaged smoke resolver supports stable and nightly unpacked app names", () => {
    const root = "/repo";

    expect(packagedAppCandidates(root, "darwin")).toEqual([
      join(root, "release", "mac", "openpond.app"),
      join(root, "release", "mac", "openpond nightly.app"),
      join(root, "release", "mac", "openpond-app.app"),
      join(root, "release", "mac", "openpond-app-nightly.app"),
      join(root, "release", "mac-arm64", "openpond.app"),
      join(root, "release", "mac-arm64", "openpond nightly.app"),
      join(root, "release", "mac-arm64", "openpond-app.app"),
      join(root, "release", "mac-arm64", "openpond-app-nightly.app"),
      join(root, "release", "mac-universal", "openpond.app"),
      join(root, "release", "mac-universal", "openpond nightly.app"),
      join(root, "release", "mac-universal", "openpond-app.app"),
      join(root, "release", "mac-universal", "openpond-app-nightly.app"),
    ]);
    expect(
      launchTargetForPath(join(root, "release", "mac", "openpond nightly.app"), "darwin").command,
    ).toBe(join(root, "release", "mac", "openpond nightly.app", "Contents", "MacOS", "openpond nightly"));

    expect(packagedAppCandidates(root, "win32")).toEqual([
      join(root, "release", "win-unpacked", "openpond.exe"),
      join(root, "release", "win-unpacked", "openpond nightly.exe"),
      join(root, "release", "win-unpacked", "openpond-app.exe"),
      join(root, "release", "win-unpacked", "openpond-app-nightly.exe"),
      join(root, "release", "win-ia32-unpacked", "openpond.exe"),
      join(root, "release", "win-ia32-unpacked", "openpond nightly.exe"),
      join(root, "release", "win-ia32-unpacked", "openpond-app.exe"),
      join(root, "release", "win-ia32-unpacked", "openpond-app-nightly.exe"),
      join(root, "release", "win-arm64-unpacked", "openpond.exe"),
      join(root, "release", "win-arm64-unpacked", "openpond nightly.exe"),
      join(root, "release", "win-arm64-unpacked", "openpond-app.exe"),
      join(root, "release", "win-arm64-unpacked", "openpond-app-nightly.exe"),
    ]);

    expect(packagedAppCandidates(root, "linux")).toEqual([
      join(root, "release", "linux-unpacked", "openpond-app"),
      join(root, "release", "linux-unpacked", "openpond-app-nightly"),
      join(root, "release", "linux-unpacked", "openpond"),
      join(root, "release", "linux-unpacked", "openpond nightly"),
      join(root, "release", "openpond-0.0.1.AppImage"),
    ]);
  });

  test("packaged smoke resolver discovers release-versioned Linux AppImages", async () => {
    const root = await mkdtemp(join(tmpdir(), "openpond-release-candidates-"));
    try {
      await mkdir(join(root, "release"), { recursive: true });
      await writeFile(join(root, "release", "openpond-nightly-0.0.5-nightly.20260702.1-linux-x64.AppImage"), "");
      await writeFile(join(root, "release", "openpond-0.1.0-linux-x64.AppImage"), "");

      expect(packagedAppCandidates(root, "linux")).toEqual([
        join(root, "release", "linux-unpacked", "openpond-app"),
        join(root, "release", "linux-unpacked", "openpond-app-nightly"),
        join(root, "release", "linux-unpacked", "openpond"),
        join(root, "release", "linux-unpacked", "openpond nightly"),
        join(root, "release", "openpond-0.1.0-linux-x64.AppImage"),
        join(root, "release", "openpond-nightly-0.0.5-nightly.20260702.1-linux-x64.AppImage"),
        join(root, "release", "openpond-0.0.1.AppImage"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates packaged smoke report artifacts before release publishing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpond-smoke-reports-"));
    try {
      await writeSmokeReport(dir, "linux-x64-appimage", "linux");
      await writeSmokeReport(dir, "linux-arm64-appimage", "linux");
      await writeSmokeReport(dir, "mac-arm64-zip", "darwin");
      await writeSmokeReport(dir, "mac-x64-zip", "darwin");

      await expect(validatePackagedSmokeReports({ dir })).resolves.toMatchObject({
        ok: true,
        reports: [
          { name: "linux-x64-appimage", platform: "linux" },
          { name: "linux-arm64-appimage", platform: "linux" },
          { name: "mac-arm64-zip", platform: "darwin" },
          { name: "mac-x64-zip", platform: "darwin" },
        ],
      });

      await writeSmokeReport(dir, "linux-x64-appimage", "darwin");
      await expect(validatePackagedSmokeReports({ dir })).rejects.toThrow(
        "smoke-linux-x64-appimage.json: expected platform linux, got darwin",
      );
      await writeSmokeReport(dir, "linux-x64-appimage", "linux");

      await rm(join(dir, "smoke-mac-arm64-zip.json"), { force: true });
      await expect(validatePackagedSmokeReports({ dir })).rejects.toThrow(
        "Missing packaged smoke report for mac-arm64-zip",
      );

      await writeSmokeReport(dir, "mac-arm64-zip", "darwin", {
        renderer: { readyState: "loading" },
      });
      await expect(validatePackagedSmokeReports({ dir })).rejects.toThrow(
        "smoke-mac-arm64-zip.json: renderer readyState must be complete",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeSmokeReport(
  dir: string,
  name: string,
  platform: NodeJS.Platform,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const report = {
    ok: true,
    platform,
    renderer: { readyState: "complete" },
    server: { health: "openpond-app-server" },
    browser: {
      tabCount: 1,
      inputProof: {
        snapshotTargetCount: 2,
        snapshotIdPresent: true,
        screenshotAvailable: true,
        moveOk: true,
        clickOk: true,
        typeOk: true,
        keyOk: true,
        clicked: true,
        submitted: true,
        typedLength: 18,
        cursorOverlay: true,
      },
      attachedAfterClose: 0,
    },
    shutdown: {
      exitedAfterClose: true,
    },
    timings: {
      desktopStartupMs: 1,
      initialRendererReadyMs: 1,
      serverHealthMs: 1,
      firstChatInputLatencyMs: 1,
    },
    ...overrides,
  };
  await writeFile(
    join(dir, `smoke-${name}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}
