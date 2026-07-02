import { ChevronDown, Maximize2, X } from "../icons";

export function WindowControls({ platform }: { platform?: string | null }) {
  if (!isDesktopShell()) return null;
  if (isMacPlatform(platform)) return null;

  return (
    <div className="window-controls" aria-label="Window controls">
      <button
        type="button"
        className="window-control minimize"
        title="Minimize"
        onClick={() => void runWindowAction("minimize")}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="window-control maximize"
        title="Maximize"
        onClick={() => void runWindowAction("toggleMaximize")}
      >
        <Maximize2 size={12} />
      </button>
      <button
        type="button"
        className="window-control close"
        title="Close"
        onClick={() => void runWindowAction("close")}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function isMacPlatform(platform?: string | null): boolean {
  const normalized = platform?.toLowerCase() ?? "";
  return normalized === "darwin" || normalized.includes("mac");
}

export function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.openpond;
  return Boolean(
    bridge?.minimizeWindow ||
      bridge?.toggleMaximizeWindow ||
      bridge?.closeWindow,
  );
}

async function runWindowAction(action: "minimize" | "toggleMaximize" | "close") {
  const bridge = window.openpond;
  if (bridge) {
    const handled =
      action === "minimize"
        ? await bridge.minimizeWindow?.()
        : action === "toggleMaximize"
          ? await bridge.toggleMaximizeWindow?.()
          : await bridge.closeWindow?.();
    if (handled !== false) return;
  }

  if (action === "toggleMaximize" && document.fullscreenEnabled) {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    return;
  }

  if (action === "close") {
    window.close();
    return;
  }

  console.warn("Window controls require the Electron desktop shell.");
}
