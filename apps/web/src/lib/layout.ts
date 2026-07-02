import type { ClientConnection } from "../api";

export const DEFAULT_SIDEBAR_WIDTH = 332;
const MIN_SIDEBAR_WIDTH = 244;
const MAX_SIDEBAR_WIDTH = 560;
export const DEFAULT_DIFF_PANEL_WIDTH = 560;
const MIN_DIFF_PANEL_WIDTH = 320;
const MAX_DIFF_PANEL_WIDTH = 920;

export function clampSidebarWidth(value: number): number {
  const viewportMax = typeof window === "undefined" ? MAX_SIDEBAR_WIDTH : Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 420));
  return Math.min(viewportMax, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

export function clampDiffPanelWidth(value: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_DIFF_PANEL_WIDTH
      : Math.min(MAX_DIFF_PANEL_WIDTH, Math.max(MIN_DIFF_PANEL_WIDTH, window.innerWidth - 360));
  return Math.min(viewportMax, Math.max(MIN_DIFF_PANEL_WIDTH, Math.round(value)));
}

export function isSameConnection(left: ClientConnection | null, right: ClientConnection): boolean {
  return Boolean(left && left.serverUrl === right.serverUrl && left.token === right.token && left.platform === right.platform);
}
