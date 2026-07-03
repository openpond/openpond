import { describe, expect, test } from "bun:test";

import {
  isNewerReleaseVersion,
  releasePlatform,
  releaseUpdateFromGitHubPayload,
  selectReleaseAsset,
  type ReleaseAsset,
} from "../apps/web/src/lib/release-updates";

const releaseAssets: ReleaseAsset[] = [
  {
    name: "openpond-0.0.9-linux-x86_64.AppImage",
    downloadUrl: "https://github.com/openpond/openpond/releases/download/v0.0.9/openpond-0.0.9-linux-x86_64.AppImage",
  },
  {
    name: "openpond-0.0.9-mac-arm64.zip",
    downloadUrl: "https://github.com/openpond/openpond/releases/download/v0.0.9/openpond-0.0.9-mac-arm64.zip",
  },
  {
    name: "openpond-cli-darwin-arm64.tar.gz",
    downloadUrl: "https://github.com/openpond/openpond/releases/download/v0.0.9/openpond-cli-darwin-arm64.tar.gz",
  },
];

describe("release update helpers", () => {
  test("compares stable app release versions", () => {
    expect(isNewerReleaseVersion("0.0.8", "0.0.9")).toBe(true);
    expect(isNewerReleaseVersion("0.0.9", "0.0.9")).toBe(false);
    expect(isNewerReleaseVersion("0.1.0", "0.0.9")).toBe(false);
  });

  test("normalizes desktop release platforms", () => {
    expect(releasePlatform("darwin")).toBe("mac");
    expect(releasePlatform("MacIntel")).toBe("mac");
    expect(releasePlatform("linux")).toBe("linux");
    expect(releasePlatform("win32")).toBe(null);
  });

  test("selects platform-specific desktop downloads", () => {
    expect(selectReleaseAsset(releaseAssets, "darwin", "arm64")?.name).toBe("openpond-0.0.9-mac-arm64.zip");
    expect(selectReleaseAsset(releaseAssets, "linux", "x64")?.name).toBe("openpond-0.0.9-linux-x86_64.AppImage");
    expect(selectReleaseAsset(releaseAssets, "darwin", "x64")).toBe(null);
    expect(selectReleaseAsset(releaseAssets, "win32", "x64")).toBe(null);
  });

  test("builds an available update from GitHub release payloads", () => {
    expect(
      releaseUpdateFromGitHubPayload({
        currentVersion: "0.0.8",
        platform: "linux",
        arch: "x64",
        payload: {
          tag_name: "v0.0.9",
          html_url: "https://github.com/openpond/openpond/releases/tag/v0.0.9",
          assets: releaseAssets.map((asset) => ({
            name: asset.name,
            browser_download_url: asset.downloadUrl,
          })),
        },
      }),
    ).toEqual({
      version: "0.0.9",
      releaseUrl: "https://github.com/openpond/openpond/releases/tag/v0.0.9",
      assetName: "openpond-0.0.9-linux-x86_64.AppImage",
      downloadUrl: "https://github.com/openpond/openpond/releases/download/v0.0.9/openpond-0.0.9-linux-x86_64.AppImage",
    });
  });
});
