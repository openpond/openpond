import { readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  stopDesktopHarnessProcess,
  trackDesktopHarnessProcess,
} from "../scripts/desktop-harness/launch";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRequire = createRequire(path.join(root, "package.json"));

describe("dev desktop smoke script", () => {
  test("is wired as a first-class package script", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.["smoke:desktop:dev"]).toBe("tsx scripts/smoke-dev-desktop.ts");
  });

  test("prints usage without launching Electron", () => {
    const result = spawnSync(process.execPath, [
      workspaceRequire.resolve("tsx/cli"),
      "scripts/smoke-dev-desktop.ts",
      "--help",
    ], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: pnpm run smoke:desktop:dev [");
  });

  test("stops an owned process group after its launcher exits", async () => {
    if (process.platform === "win32") return;
    const fixture = [
      'const { spawn } = require("node:child_process");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      'console.log(`READY ${JSON.stringify({ descendantPid: descendant.pid })}`);',
      "setTimeout(() => process.exit(0), 20);",
    ].join("\n");
    const launcher = spawn(process.execPath, ["-e", fixture], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const groupPid = launcher.pid;
    if (!groupPid) throw new Error("Process-tree fixture did not start.");
    const handle = trackDesktopHarnessProcess("process-tree-fixture", launcher);

    try {
      const descendantPid = await readyDescendantPid(launcher);
      await waitForExit(launcher);

      await stopDesktopHarnessProcess(handle);

      await expect(waitUntilGone(descendantPid)).resolves.toBeUndefined();
    } finally {
      try {
        process.kill(-groupPid, "SIGKILL");
      } catch {
        // The process group was cleaned up by the assertion path.
      }
    }
  });
});

function readyDescendantPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Process-tree fixture timed out.")), 5_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/READY ({[^\n]+})/);
      if (!match) return;
      clearTimeout(timer);
      resolve((JSON.parse(match[1]!) as { descendantPid: number }).descendantPid);
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Process-tree launcher did not exit.")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Owned descendant ${pid} remained alive.`);
}
