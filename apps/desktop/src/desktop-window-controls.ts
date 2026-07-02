import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { desktopLogger } from "./desktop-environment.js";

function mediaSourceWindowId(window: BrowserWindow): string | null {
  const match = /^window:(\d+):/.exec(window.getMediaSourceId());
  return match?.[1] ?? null;
}

function runQuietCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: "ignore" });
    const done = (handled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(handled);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, 800);
    child.once("error", () => done(false));
    child.once("exit", (code) => done(code === 0));
  });
}

async function minimizeWithLinuxWindowManager(window: BrowserWindow): Promise<boolean> {
  if (!process.env.DISPLAY) return false;
  const windowId = mediaSourceWindowId(window);
  if (!windowId) return false;
  const hexWindowId = `0x${BigInt(windowId).toString(16)}`;
  const commands: Array<[string, string[]]> = [
    ["xdotool", ["windowminimize", windowId]],
    ["/usr/bin/xdotool", ["windowminimize", windowId]],
    ["wmctrl", ["-i", "-r", hexWindowId, "-b", "add,hidden"]],
    ["/usr/bin/wmctrl", ["-i", "-r", hexWindowId, "-b", "add,hidden"]],
  ];

  for (const [command, args] of commands) {
    if (await runQuietCommand(command, args)) return true;
  }
  return false;
}

export async function minimizeWindow(window: BrowserWindow): Promise<boolean> {
  if (process.platform !== "linux" && !window.isMinimizable()) return false;
  window.setSkipTaskbar(false);
  if (window.isFullScreen()) window.setFullScreen(false);
  if (process.platform === "linux" && (await minimizeWithLinuxWindowManager(window))) return true;
  window.minimize();
  if (process.platform === "linux") {
    setTimeout(() => {
      if (!window.isDestroyed() && window.isVisible()) window.hide();
    }, 140);
  }
  return true;
}
