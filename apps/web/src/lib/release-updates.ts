export type ReleaseAsset = {
  name: string;
  downloadUrl: string;
};

export type ReleaseUpdate = {
  version: string;
  releaseUrl: string;
  assetName: string;
  downloadUrl: string;
};

type GitHubReleasePayload = {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
};

type Semver = [number, number, number];

function parseSemver(value: string | null | undefined): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

export function isNewerReleaseVersion(currentVersion: string | null | undefined, releaseVersion: string): boolean {
  const current = parseSemver(currentVersion);
  const release = parseSemver(releaseVersion);
  if (!current || !release) return false;
  for (let index = 0; index < release.length; index += 1) {
    if (release[index]! > current[index]!) return true;
    if (release[index]! < current[index]!) return false;
  }
  return false;
}

export function releasePlatform(platform: string | null | undefined): "mac" | "linux" | null {
  const normalized = platform?.toLowerCase() ?? "";
  if (normalized === "darwin" || normalized.includes("mac")) return "mac";
  if (normalized === "linux" || normalized.includes("linux")) return "linux";
  return null;
}

function releaseArch(arch: string | null | undefined): "arm64" | "x64" | null {
  const normalized = arch?.toLowerCase() ?? "";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x64";
  return null;
}

export function selectReleaseAsset(
  assets: ReleaseAsset[],
  platform: string | null | undefined,
  arch: string | null | undefined,
): ReleaseAsset | null {
  const targetPlatform = releasePlatform(platform);
  const targetArch = releaseArch(arch);
  if (targetPlatform === "mac") {
    const macZips = assets.filter((asset) => /-mac-.*\.zip$/i.test(asset.name));
    if (targetArch === "arm64") return macZips.find((asset) => /-mac-arm64\.zip$/i.test(asset.name)) ?? null;
    if (targetArch === "x64") {
      return (
        macZips.find((asset) => /-mac-x64\.zip$/i.test(asset.name)) ??
        macZips.find((asset) => /-mac-universal\.zip$/i.test(asset.name)) ??
        null
      );
    }
    return (
      macZips.find((asset) => /-mac-universal\.zip$/i.test(asset.name)) ??
      macZips.find((asset) => /-mac-arm64\.zip$/i.test(asset.name)) ??
      macZips[0] ??
      null
    );
  }
  if (targetPlatform === "linux") {
    const appImages = assets.filter((asset) => /\.AppImage$/i.test(asset.name));
    if (targetArch === "arm64") {
      return (
        appImages.find((asset) => /(?:arm64|aarch64).*\.AppImage$/i.test(asset.name)) ??
        null
      );
    }
    if (targetArch === "x64") {
      return (
        appImages.find((asset) => /(?:x86_64|x64|amd64).*\.AppImage$/i.test(asset.name)) ??
        appImages[0] ??
        null
      );
    }
    return appImages[0] ?? null;
  }
  return null;
}

export function releaseUpdateFromGitHubPayload(input: {
  payload: unknown;
  currentVersion: string | null | undefined;
  platform: string | null | undefined;
  arch: string | null | undefined;
}): ReleaseUpdate | null {
  if (!input.payload || typeof input.payload !== "object") return null;
  const payload = input.payload as GitHubReleasePayload;
  const rawTag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const version = rawTag.replace(/^v/, "");
  if (!isNewerReleaseVersion(input.currentVersion, version)) return null;
  const releaseUrl = typeof payload.html_url === "string" ? payload.html_url : "";
  const rawAssets = Array.isArray(payload.assets) ? payload.assets : [];
  const assets = rawAssets.flatMap((asset): ReleaseAsset[] => {
    if (!asset || typeof asset !== "object") return [];
    const record = asset as { name?: unknown; browser_download_url?: unknown };
    if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") return [];
    return [{ name: record.name, downloadUrl: record.browser_download_url }];
  });
  const selectedAsset = selectReleaseAsset(assets, input.platform, input.arch);
  if (!selectedAsset || !releaseUrl) return null;
  return {
    version,
    releaseUrl,
    assetName: selectedAsset.name,
    downloadUrl: selectedAsset.downloadUrl,
  };
}
