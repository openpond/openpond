import { execFile, type ChildProcess } from "node:child_process";

/** Native tools inherit a private process group; closing a chat must also close its tools. */
export function signalNativeProcess(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true }, () => undefined);
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
