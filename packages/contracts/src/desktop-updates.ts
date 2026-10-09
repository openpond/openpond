export type DesktopUpdateInstallKind = "mac" | "appimage" | "deb" | "unsupported";
export type DesktopUpdateStatus =
  | "unsupported" | "idle" | "checking" | "current" | "available"
  | "downloading" | "ready" | "restarting" | "error";

export type DesktopUpdateState = {
  revision: number;
  status: DesktopUpdateStatus;
  installedVersion: string;
  version: string | null;
  channel: "stable" | "nightly";
  installKind: DesktopUpdateInstallKind;
  progress: number | null;
  error: string | null;
  retry: "check" | "download" | "restart" | null;
};

export type DesktopUpdateRestartRequest = {
  hasRunningWork: boolean;
};

export type DesktopUpdatesBridge = {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  restartAndInstall(request: DesktopUpdateRestartRequest): Promise<DesktopUpdateState>;
  onState(listener: (state: DesktopUpdateState) => void): () => void;
};

// Match electron-builder and GenericProvider's platform/architecture suffixes.
// Each architecture gets its own channel so Mac matrix jobs cannot overwrite
// the other architecture's manifest when release assets are collected.
export function desktopUpdateFeedChannel(channel: "stable" | "nightly", arch: "x64" | "arm64"): string {
  return `${channel === "stable" ? "latest" : "nightly"}-${arch}`;
}

export function desktopUpdateManifestName(
  channel: "stable" | "nightly",
  platform: "darwin" | "linux",
  arch: "x64" | "arm64",
): string {
  const suffix = platform === "darwin" ? "mac" : arch === "x64" ? "linux" : "linux-arm64";
  return `${desktopUpdateFeedChannel(channel, arch)}-${suffix}.yml`;
}
