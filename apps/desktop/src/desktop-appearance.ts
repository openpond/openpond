import { app, BrowserWindow, nativeTheme } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { UI_THEME_COLORS } from "@openpond/contracts/ui-theme.generated";

type Preference = "dark" | "light" | "system";
let initialized = false;
const windows = new Set<BrowserWindow>();
const preferenceFile = () => path.join(app.getPath("userData"), "appearance.json");

export function resolvedDesktopTheme(): "dark" | "light" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function desktopBackground(): string {
  return UI_THEME_COLORS[resolvedDesktopTheme()]["--surface-page"];
}

function updateWindows(): void {
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    window.setBackgroundColor(desktopBackground());
    // Recovery pages have no application bootstrap or storage origin.
    if (window.webContents.getURL().startsWith("data:text/html")) {
      void window.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(resolvedDesktopTheme())}`).catch(() => undefined);
    }
  }
}

export function initializeDesktopAppearance(): void {
  if (initialized) return;
  initialized = true;
  let preference: Preference = "system";
  try {
    const saved: unknown = JSON.parse(readFileSync(preferenceFile(), "utf8"));
    if (saved === "dark" || saved === "light") preference = saved;
  } catch { /* First launch or an invalid local preference uses the system theme. */ }
  nativeTheme.themeSource = preference;
  nativeTheme.on("updated", updateWindows);
}

export function trackWindowAppearance(window: BrowserWindow): void {
  windows.add(window);
  window.once("closed", () => windows.delete(window));
}

export function setDesktopAppearance(value: unknown): void {
  if (value !== "light" && value !== "dark" && value !== "system") throw new Error("Invalid appearance preference.");
  if (nativeTheme.themeSource === value) return;
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(preferenceFile(), JSON.stringify(value), "utf8");
  nativeTheme.themeSource = value;
  updateWindows();
}
