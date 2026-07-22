import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  launchTargetForPath,
  packagedAppCandidates,
} from "../scripts/smoke-packaged-desktop";
import { stageReleaseSourceArtifacts } from "../scripts/stage-release-source-artifacts";
import { validatePackagedSmokeReports } from "../scripts/validate-packaged-smoke-reports";

const WORKFLOW_PATH = ".github/workflows/release-builds.yml";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const ROOT_PACKAGE_PATH = "package.json";
const RELEASE_COMMAND_PATH = "scripts/release-stable.ts";
const LATEST_STABLE_TAG_SCRIPT_PATH = "scripts/latest-stable-release-tag.sh";

describe("release workflow", () => {
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
    expect(workflow).toContain("run: pnpm run release:version:check --version");
    expect(workflow.indexOf("name: Verify stable source version")).toBeLessThan(
      workflow.indexOf("name: Require green CI"),
    );
    expect(workflow.indexOf("name: Verify stable source version")).toBeLessThan(
      workflow.indexOf("name: Build release source artifacts once"),
    );
    expect(workflow).toContain("name: Wait for the required CI check on this commit");
    expect(workflow).toContain('select(.name == "Checks" and .app.slug == "github-actions")');
    expect(workflow.match(/pnpm run test/g) ?? []).toHaveLength(0);
    expect(workflow).not.toContain("name: Run tests on Windows");
    expect(workflow).not.toContain("vitest run tests/*.test.ts");
    expect(workflow.match(/pnpm run build:artifacts/g)).toHaveLength(1);
    expect(workflow.match(/pnpm run cli:build/g)).toHaveLength(1);
    expect(workflow).not.toContain("- run: pnpm run build\n");
    expect(workflow).toContain("name: release-source-artifacts");
    expect(workflow).toContain("name: Stage release source artifacts");
    expect(workflow).toContain("run: pnpm run release:source-artifacts:stage");
    expect(workflow).toMatch(
      /name: release-source-artifacts\n\s+path: release-source-artifacts\n\s+if-no-files-found: error/,
    );
    expect(workflow).not.toMatch(/path:\s*\|\n(?:\s+(?:apps|packages)\/.+\/dist\n)+/);
    expect(
      workflow.match(
        /actions\/download-artifact@[0-9a-f]{40} # v8\n\s+with:\n\s+name: release-source-artifacts\n\s+path: \./g,
      ),
    ).toHaveLength(3);
    expect(workflow).not.toMatch(
      /name: release-source-artifacts\n\s+path: apps/,
    );

    expect(workflow).toContain("name: Smoke packaged desktop");
    expect(workflow).toContain("name: Prove renderer commit boundaries in the dev browser harness");
    expect(workflow).toMatch(
      /name: Prove renderer commit boundaries in the dev browser harness\n\s+if: matrix\.name == 'linux-x64-appimage'\n\s+timeout-minutes: 10/,
    );
    expect(workflow).toContain("dev-render-commits.json");
    expect(workflow).toContain("mkdir -p release-smoke");
    expect(workflow).toContain('report_path="release-smoke/smoke-${{ matrix.name }}.json"');
    expect(workflow).toContain('xvfb-run -a pnpm run smoke:desktop:packaged --json "${report_path}"');
    expect(workflow).toContain('pnpm run smoke:desktop:packaged --json "${report_path}"');
    expect(workflow).toContain("name: packaged-smoke-${{ matrix.name }}");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("path: release-smoke/**");
    expect(workflow).toContain("pattern: packaged-smoke-*");
    expect(workflow).toContain("path: release-smoke-artifacts");
    expect(workflow).toContain("name: Validate packaged smoke reports");
    expect(workflow).toContain("pnpm run smoke:desktop:packaged:validate --dir release-smoke-artifacts");
    expect(workflow).not.toMatch(/pnpm run [^\n]* -- --/);
    expect(workflow).not.toContain("name: Build and verify native CLI archive");
    expect(workflow).not.toContain("cli:release:build");
    expect(workflow).not.toContain("--archive");
    expect(workflow).not.toContain("npm_publish_auth");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).toContain("environment: npm-production");
    expect(workflow).toContain("name: Publish stable CLI package to npm");
    expect(workflow).toContain("npm install --global npm@11.18.0\n          npm publish ./apps/cli --access public --ignore-scripts");
    expect(workflow).not.toContain("release/*.tar.gz");
    expect(workflow).not.toContain("setup-bun");
    expect(workflow).not.toMatch(/\bbun (?:install|run|x|test)\b/);
    expect(workflow).toContain('basename "${files[$index]}"');
    expect(workflow).toContain("builder-debug.yml");
    expect(workflow).not.toContain("runs-on: ubuntu-latest\n    runs-on: ubuntu-latest");
  });

  test("publishes stable releases only after a version change reaches protected master", () => {
    const releaseWorkflow = readFileSync(WORKFLOW_PATH, "utf8");
    const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, "utf8");

    expect(ciWorkflow).toMatch(/push:\n\s+branches:\n\s+- master/);
    expect(ciWorkflow).not.toContain("branches-ignore");
    expect(releaseWorkflow).not.toMatch(/push:\n\s+tags:/);
    expect(releaseWorkflow).toMatch(
      /push:\n\s+branches:\n\s+- master\n\s+paths:\n\s+- "apps\/desktop\/package\.json"/,
    );
    expect(releaseWorkflow).toContain('"${GITHUB_EVENT_NAME}" == "push"');
    expect(releaseWorkflow).toContain('git cat-file -e "${GITHUB_SHA}^:apps/desktop/package.json"');
    expect(releaseWorkflow).toContain('git show "${GITHUB_SHA}^:apps/desktop/package.json"');
    expect(releaseWorkflow).toContain('"${raw_version}" == "${previous_version}"');
    expect(releaseWorkflow).toContain('steps.release.outputs.should_release == \'true\'');
    expect(releaseWorkflow).toContain("Stable tag v${version} already exists");
    expect(releaseWorkflow).toContain("must be newer than ${latest_stable_version}");
    expect(releaseWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'schedule' }}");
    expect(releaseWorkflow).toContain("checks: read");
    expect(ciWorkflow).toContain("name: Checks");
    expect(ciWorkflow).toContain("needs: [quality, unit, integration, contract, release_smoke]");
    expect(ciWorkflow).toContain("pnpm run test:unit");
    expect(ciWorkflow).toContain("pnpm run test:integration");
    expect(ciWorkflow).toContain("pnpm run test:contract");
    expect(ciWorkflow).toContain("pnpm run test:release");
    expect(ciWorkflow).not.toContain("setup-bun");
    expect(ciWorkflow).not.toMatch(/\bbun (?:install|run|x|test)\b/);
    expect(ciWorkflow).toMatch(
      /name: verified-build-\$\{\{ github\.sha \}\}[\s\S]*?packages\/cloud\/dist/,
    );
    expect(ciWorkflow).toMatch(
      /release_smoke:[\s\S]*?actions\/download-artifact@[0-9a-f]{40} # v8[\s\S]*?path: \./,
    );
    expect(ciWorkflow).not.toContain("OPENPOND_SKIP_CI_LONG_CLI_TESTS");
  });

  test("ignores prerelease tags when resolving the latest stable release", async () => {
    const repo = await mkdtemp(join(tmpdir(), "openpond-stable-release-tags-"));
    const resolver = join(process.cwd(), LATEST_STABLE_TAG_SCRIPT_PATH);

    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "release-test@openpond.ai"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "OpenPond Release Test"], { cwd: repo });
      await writeFile(join(repo, "README.md"), "release tag fixture\n");
      execFileSync("git", ["add", "README.md"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

      for (const tag of [
        "v0.0.33",
        "v0.0.34",
        "v0.0.35-nightly.20260721.1",
        "v0.0.35-rc.1",
      ]) {
        execFileSync("git", ["tag", tag], { cwd: repo });
      }

      expect(execFileSync("bash", [resolver], { cwd: repo, encoding: "utf8" }).trim()).toBe(
        "v0.0.34",
      );

      execFileSync("git", ["tag", "v0.0.35"], { cwd: repo });
      expect(execFileSync("bash", [resolver], { cwd: repo, encoding: "utf8" }).trim()).toBe(
        "v0.0.35",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("keeps protected master writes out of the local release command", () => {
    const releaseCommand = readFileSync(RELEASE_COMMAND_PATH, "utf8");

    expect(releaseCommand).not.toContain('["push", "origin", "master"]');
    expect(releaseCommand).not.toContain('["tag", "-a"');
    expect(releaseCommand).toContain('"pr",\n      "create"');
    expect(releaseCommand).toContain('"workflow",\n      "run"');
    expect(releaseCommand).toContain('"push", "--set-upstream", "origin", plan.branch');
  });

  test("scopes release credentials to the publishing job and uses current action runtimes", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toMatch(/npm_publish:\n[\s\S]*?environment: npm-production[\s\S]*?permissions:\n\s+contents: read\n\s+id-token: write/);
    expect(workflow).toMatch(/release:\n[\s\S]*?permissions:\n\s+contents: write/);
    expect(workflow.match(/contents: write/g)).toHaveLength(1);
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40} # v7/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40} # v6\.4\.0/);
    expect(workflow).toMatch(/pnpm\/action-setup@[0-9a-f]{40} # v6\.0\.8/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v7/);
    expect(workflow).toMatch(/actions\/download-artifact@[0-9a-f]{40} # v8/);
    expect(workflow).toMatch(/softprops\/action-gh-release@[0-9a-f]{40} # v3/);
    expect(workflow).not.toMatch(/^\s*(?:-\s*)?uses:\s+[^\s#]+@v\d+/m);
  });

  test("builds standalone desktop bundles before staging release packages", () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.build).toContain("pnpm run build:artifacts");
    expect(packageJson.scripts?.["build:artifacts"]).toContain("pnpm run build:desktop");
  });

  test("keeps the stable release guard available as a package script", () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["release:version:check"]).toBe(
      "tsx scripts/check-release-version.ts",
    );
  });

  test("builds server workspace dependencies before bundling release artifacts", () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["bundle:server"]).toMatch(
      /^tsc -b apps\/server && tsx scripts\/build\/bundle-server\.ts$/,
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
