import { useEffect, useState } from "react";
import { releasePlatform, releaseUpdateFromGitHubPayload, type ReleaseUpdate } from "../lib/release-updates";

const RELEASE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LATEST_RELEASE_URL = "https://api.github.com/repos/openpond/openpond/releases/latest";

export type ReleaseUpdateState = {
  status: "idle" | "checking" | "current" | "available" | "error";
  update: ReleaseUpdate | null;
  lastCheckedAt: number | null;
};

export function useReleaseUpdateCheck(input: {
  currentVersion: string | null | undefined;
  platform: string | null | undefined;
  arch: string | null | undefined;
  enabled: boolean;
}): ReleaseUpdateState {
  const [state, setState] = useState<ReleaseUpdateState>({
    status: "idle",
    update: null,
    lastCheckedAt: null,
  });
  const currentVersion = input.currentVersion?.trim() ?? "";
  const platform = input.platform ?? "";
  const arch = input.arch ?? "";
  const enabled = input.enabled && Boolean(currentVersion) && Boolean(releasePlatform(platform));

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle", update: null, lastCheckedAt: null });
      return;
    }

    let cancelled = false;

    async function checkForUpdates(): Promise<void> {
      setState((current) => ({
        ...current,
        status: current.update ? "available" : "checking",
      }));
      try {
        const response = await fetch(LATEST_RELEASE_URL, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) throw new Error(`GitHub release check failed: ${response.status}`);
        const payload = await response.json();
        const update = releaseUpdateFromGitHubPayload({
          payload,
          currentVersion,
          platform,
          arch,
        });
        if (cancelled) return;
        setState({
          status: update ? "available" : "current",
          update,
          lastCheckedAt: Date.now(),
        });
      } catch {
        if (cancelled) return;
        setState((current) => ({
          status: current.update ? "available" : "error",
          update: current.update,
          lastCheckedAt: Date.now(),
        }));
      }
    }

    void checkForUpdates();
    const interval = window.setInterval(() => {
      void checkForUpdates();
    }, RELEASE_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [arch, currentVersion, enabled, platform]);

  return state;
}
