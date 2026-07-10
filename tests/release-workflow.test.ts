import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  launchTargetForPath,
  packagedAppCandidates,
} from "../scripts/smoke-packaged-desktop";
import { validatePackagedSmokeReports } from "../scripts/validate-packaged-smoke-reports";

const WORKFLOW_PATH = ".github/workflows/release-builds.yml";
const CLI_INSTALLER_PATH = "apps/cli/install.sh";

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

    expect(workflow).toContain("name: Run tests");
    expect(workflow).toContain("bun run test");
    expect(workflow).not.toContain("name: Run tests on Windows");
    expect(workflow).not.toContain("bun test tests/*.test.ts");

    expect(workflow).toContain("name: Smoke packaged desktop");
    expect(workflow).toContain("name: Prove renderer commit boundaries in the dev browser harness");
    expect(workflow).toContain("dev-render-commits.json");
    expect(workflow).toContain("mkdir -p release-smoke");
    expect(workflow).toContain('report_path="release-smoke/smoke-${{ matrix.name }}.json"');
    expect(workflow).toContain('xvfb-run -a bun run smoke:desktop:packaged -- --json "${report_path}"');
    expect(workflow).toContain('bun run smoke:desktop:packaged -- --json "${report_path}"');
    expect(workflow).toContain("name: packaged-smoke-${{ matrix.name }}");
    expect(workflow).toContain("path: release-smoke/*.json");
    expect(workflow).toContain("pattern: packaged-smoke-*");
    expect(workflow).toContain("path: release-smoke-artifacts");
    expect(workflow).toContain("name: Validate packaged smoke reports");
    expect(workflow).toContain("bun run smoke:desktop:packaged:validate -- --dir release-smoke-artifacts");
    expect(workflow).toContain("name: Build and verify CLI distributions");
    expect(workflow).toContain("bun run cli:build");
    expect(workflow).toContain("bun run cli:release:build");
    expect(workflow).toContain("bun scripts/check-cli-distribution.ts --archive");
    expect(workflow).toContain("name: Publish stable CLI package to npm");
    expect(workflow).toContain("npm publish ./apps/cli --access public --provenance");
    expect(workflow).toContain("release/*.tar.gz");
    expect(workflow).toContain('basename "${files[$index]}"');
    expect(workflow).toContain("builder-debug.yml");
    expect(workflow).not.toContain("runs-on: ubuntu-latest\n    runs-on: ubuntu-latest");
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
