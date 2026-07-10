import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { createReadyLineParser } from "@openpond/runtime";
import { stopTerminalProcessTree } from "../apps/terminal/src/connection";

describe("terminal process ownership", () => {
  test("gracefully terminates the owned server process group and its descendant", async () => {
    if (process.platform === "win32") return;
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'console.log(`READY ${JSON.stringify({ descendantPid: child.pid })}`);',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    const owned = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "pipe",
    });
    owned.stdin.end();
    const descendantPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("owned process fixture did not become ready")), 5_000);
      const parser = createReadyLineParser<{ descendantPid: number }>("READY ", (payload) => {
        clearTimeout(timer);
        resolve(payload.descendantPid);
      });
      owned.stdout.on("data", (chunk) => parser.push(String(chunk)));
      owned.once("error", reject);
      owned.once("exit", (code, signal) => reject(new Error(`fixture exited early: ${code ?? signal}`)));
    });

    await stopTerminalProcessTree(owned, { gracefulTimeoutMs: 2_000, killTimeoutMs: 2_000 });

    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    await expect(waitUntilProcessGone(descendantPid)).resolves.toBeUndefined();
  });
});

async function waitUntilProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`descendant process ${pid} remained alive`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
