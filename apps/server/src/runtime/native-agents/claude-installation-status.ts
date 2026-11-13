import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeInstallationStatus } from "@openpond/contracts/providers";

const releaseOrigin = "https://downloads.claude.ai/claude-code-releases";
const versionPattern = /^\d+\.\d+\.\d+$/;

/** Public release metadata is shared; installation and account diagnostics are not. */
export function createClaudeReleaseReader(fetchImpl?: typeof fetch) {
  let pending: Promise<{ stableVersion: string | null; latestVersion: string | null; updateError: string | null; checkedAt: string }> | null = null;
  let expiresAt = 0;
  return () => {
    if (pending && Date.now() < expiresAt) return pending;
    expiresAt = Date.now() + 60 * 60_000;
    pending = (async () => {
      try {
        const [stableVersion, latestVersion] = await Promise.all(["stable", "latest"].map(async channel => {
          const response = await (fetchImpl ?? fetch)(`${releaseOrigin}/${channel}`, { signal: AbortSignal.timeout(5_000), redirect: "error", credentials: "omit" });
          if (!response.ok) throw new Error("Release check failed");
          const version = (await response.text()).trim();
          if (!versionPattern.test(version)) throw new Error("Invalid release version");
          return version;
        }));
        return { stableVersion: stableVersion!, latestVersion: latestVersion!, updateError: null, checkedAt: new Date().toISOString() };
      } catch {
        expiresAt = Date.now() + 60_000;
        return { stableVersion: null, latestVersion: null, updateError: "Could not check Claude Code releases. Sign-in and model discovery can continue. Use Refresh to retry.", checkedAt: new Date().toISOString() };
      }
    })();
    return pending;
  };
}

const readReleases = createClaudeReleaseReader();

export async function readClaudeInstallationStatus(launch: { command: string; env: NodeJS.ProcessEnv }, version: string | null, signal?: AbortSignal): Promise<NativeInstallationStatus> {
  const [releases, doctor] = await Promise.all([
    readReleases(),
    promisify(execFile)(launch.command, ["doctor"], { env: launch.env, signal, timeout: 5_000, maxBuffer: 64 * 1024 })
      .then(result => result.stdout, () => ""),
  ]);
  const channel = /(?:^|\n)Auto-update channel:\s*(stable|latest)\s*(?:\n|$)/.exec(doctor)?.[1] as "stable" | "latest" | undefined;
  const installed = version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  const newer = installed && releases.latestVersion
    ? releases.latestVersion.localeCompare(installed, "en", { numeric: true }) > 0 : false;
  return { executablePath: launch.command, version, channel: channel ?? null, ...releases, updateAvailable: newer };
}
