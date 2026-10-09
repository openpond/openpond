import semver from "semver";
import { desktopUpdateManifestName, type DesktopUpdateInstallKind } from "@openpond/contracts/desktop-updates";

export type DesktopUpdateTarget = {
  channel: "stable" | "nightly";
  platform: "darwin" | "linux";
  arch: "x64" | "arm64";
  installedVersion: string;
};

export type DesktopUpdateRelease = { version: string; feedUrl: string };

const RELEASE_DOWNLOAD_ROOT = "https://github.com/openpond/openpond/releases/download/";

export function validateDesktopUpdateManifest(
  raw: { version: string; files: Array<{ url: string; sha512: string }> },
  target: DesktopUpdateTarget,
  installKind: Exclude<DesktopUpdateInstallKind, "unsupported">,
  selectedVersion: string,
): { url: string; sha512: string } {
  if (raw.version !== selectedVersion || !semver.gt(raw.version, target.installedVersion) || !raw.files?.length) {
    throw new Error("Desktop update manifest does not match the selected release.");
  }
  const prefix = target.channel === "nightly" ? "openpond-nightly" : "openpond";
  const platform = target.platform === "darwin" ? "mac" : "linux";
  const basename = `${prefix}-${selectedVersion}-${platform}-${target.arch}`;
  const extensions = installKind === "mac" ? ["zip"] : ["AppImage", "deb"];
  for (const file of raw.files) {
    if (!extensions.some((extension) => file.url === `${basename}.${extension}`) ||
        typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
      throw new Error("Desktop update manifest contains an unexpected artifact.");
    }
  }
  const extension = installKind === "mac" ? "zip" : installKind === "deb" ? "deb" : "AppImage";
  const selected = raw.files.find((file) => file.url === `${basename}.${extension}`);
  if (!selected) throw new Error("Desktop update manifest is missing the installed package format.");
  return selected;
}

export function selectDesktopUpdateRelease(payload: unknown, target: DesktopUpdateTarget): DesktopUpdateRelease | null {
  if (!Array.isArray(payload)) throw new Error("Invalid desktop release response.");
  const manifestName = desktopUpdateManifestName(target.channel, target.platform, target.arch);
  const candidates: DesktopUpdateRelease[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const release = raw as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
    if (release.draft !== false || typeof release.tag_name !== "string") continue;
    // This repository also publishes cli-v*, sdk-v*, and other independent tags.
    const tag = release.tag_name;
    const pattern = target.channel === "stable"
      ? /^v\d+\.\d+\.\d+$/ : /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
    if (!pattern.test(tag) || release.prerelease !== (target.channel === "nightly")) continue;
    const version = tag.slice(1);
    if (!semver.valid(version) || !semver.gt(version, target.installedVersion)) continue;
    const feedUrl = `${RELEASE_DOWNLOAD_ROOT}${encodeURIComponent(tag)}/`;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (!assets.some((rawAsset) => {
      if (!rawAsset || typeof rawAsset !== "object") return false;
      const asset = rawAsset as { name?: unknown; browser_download_url?: unknown };
      return asset.name === manifestName && asset.browser_download_url === `${feedUrl}${manifestName}`;
    })) continue;
    candidates.push({ version, feedUrl });
  }
  return candidates.sort((a, b) => semver.rcompare(a.version, b.version))[0] ?? null;
}

export async function findDesktopUpdateRelease(target: DesktopUpdateTarget, signal: AbortSignal): Promise<DesktopUpdateRelease | null> {
  // Fetch desktop releases explicitly instead of releases/latest, which can be
  // an independently published CLI or SDK release.
  const response = await fetch("https://api.github.com/repos/openpond/openpond/releases?per_page=100", {
    headers: { Accept: "application/vnd.github+json" }, signal,
  });
  if (!response.ok) throw new Error(`Desktop release check failed (${response.status}).`);
  return selectDesktopUpdateRelease(await response.json(), target);
}
