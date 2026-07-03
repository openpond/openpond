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

describe("release workflow", () => {
  test("keeps packaged desktop smoke wired for Linux, macOS, and Windows release builds", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("- name: linux-appimage");
    expect(workflow).toContain("os: ubuntu-latest");
    expect(workflow).toContain("package_script: package:linux:release");

    expect(workflow).toContain("- name: mac-zip");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("package_script: package:mac:release");

    expect(workflow).toContain("- name: windows-nsis");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("package_script: package:win:release");
    expect(workflow).not.toMatch(/#\s*-\s*name:\s*windows-nsis/);

    expect(workflow).toContain("name: Run tests");
    expect(workflow).toContain("bun run test");
    expect(workflow).not.toContain("name: Run tests on Windows");
    expect(workflow).not.toContain("bun test tests/*.test.ts");

    expect(workflow).toContain("name: Smoke packaged desktop");
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
    expect(workflow).toContain("name: Build CLI installer tarball");
    expect(workflow).toContain("bun build apps/cli/src/cli/main.ts --compile --outfile release-cli/openpond");
    expect(workflow).toContain("cp apps/cli/package.json release-cli/package.json");
    expect(workflow).toContain("openpond-cli-${cli_os}-${cli_arch}.tar.gz");
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
      join(root, "release", "mac-arm64", "openpond.app"),
      join(root, "release", "mac-arm64", "openpond nightly.app"),
      join(root, "release", "mac-universal", "openpond.app"),
      join(root, "release", "mac-universal", "openpond nightly.app"),
    ]);
    expect(
      launchTargetForPath(join(root, "release", "mac", "openpond nightly.app"), "darwin").command,
    ).toBe(join(root, "release", "mac", "openpond nightly.app", "Contents", "MacOS", "openpond nightly"));

    expect(packagedAppCandidates(root, "win32")).toEqual([
      join(root, "release", "win-unpacked", "openpond.exe"),
      join(root, "release", "win-unpacked", "openpond nightly.exe"),
      join(root, "release", "win-ia32-unpacked", "openpond.exe"),
      join(root, "release", "win-ia32-unpacked", "openpond nightly.exe"),
      join(root, "release", "win-arm64-unpacked", "openpond.exe"),
      join(root, "release", "win-arm64-unpacked", "openpond nightly.exe"),
    ]);

    expect(packagedAppCandidates(root, "linux")).toEqual([
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
      await writeSmokeReport(dir, "linux-appimage", "linux");
      await writeSmokeReport(dir, "mac-zip", "darwin");
      await writeSmokeReport(dir, "windows-nsis", "win32");

      await expect(validatePackagedSmokeReports({ dir })).resolves.toMatchObject({
        ok: true,
        reports: [
          { name: "linux-appimage", platform: "linux" },
          { name: "mac-zip", platform: "darwin" },
          { name: "windows-nsis", platform: "win32" },
        ],
      });

      await writeSmokeReport(dir, "windows-nsis", "linux");
      await expect(validatePackagedSmokeReports({ dir })).rejects.toThrow(
        "smoke-windows-nsis.json: expected platform win32, got linux",
      );

      await rm(join(dir, "smoke-mac-zip.json"), { force: true });
      await expect(validatePackagedSmokeReports({ dir })).rejects.toThrow(
        "Missing packaged smoke report for mac-zip",
      );

      await writeSmokeReport(dir, "mac-zip", "darwin", {
        renderer: { readyState: "loading" },
      });
      await writeSmokeReport(dir, "windows-nsis", "win32");
      await expect(validatePackagedSmokeReports({ dir })).rejects.toThrow(
        "smoke-mac-zip.json: renderer readyState must be complete",
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
