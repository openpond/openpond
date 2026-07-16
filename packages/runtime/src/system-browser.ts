import { spawn } from "node:child_process";

export type SystemBrowserCommand = {
  command: string;
  args: string[];
};

export type SystemBrowserOpenResult =
  | { opened: true }
  | { opened: false; error: string };

export type SystemBrowserOpenOptions = {
  command?: SystemBrowserCommand;
  handoffTimeoutMs?: number;
};

export function resolveSystemBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): SystemBrowserCommand {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { command: "xdg-open", args: [url] };
}

export async function openUrlWithSystemBrowser(
  url: string,
  options: SystemBrowserOpenOptions = {},
): Promise<SystemBrowserOpenResult> {
  const browser = options.command ?? resolveSystemBrowserCommand(url);
  const handoffTimeoutMs = options.handoffTimeoutMs ?? 1_500;

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: SystemBrowserOpenResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(browser.command, browser.args, {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish({
        opened: false,
        error: code
          ? `browser launcher ${browser.command} failed (${code})`
          : `browser launcher ${browser.command} failed`,
      });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ opened: true });
        return;
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      finish({ opened: false, error: `browser launcher ${browser.command} exited with ${detail}` });
    });

    timer = setTimeout(() => {
      child.unref();
      finish({ opened: true });
    }, handoffTimeoutMs);
    timer.unref();
  });
}
