import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createReadyLineParser } from "@openpond/runtime";
import { DesktopBackendManager } from "../apps/desktop/src/desktop-backend-manager";

describe("desktop backend ownership", () => {
  test("never stops a reused server and closes idempotently", async () => {
    const manager = new DesktopBackendManager();
    manager.useReusedServer();
    expect(manager.status()).toEqual({ server: "reused", renderer: "none" });
    const first = manager.close();
    const second = manager.close();
    expect(second).toBe(first);
    await first;
  });

  test("stops the complete owned server process group", async () => {
    if (process.platform === "win32") return;
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'console.log(`READY ${JSON.stringify({ descendantPid: child.pid })}`);',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    const owned = spawn(process.execPath, ["-e", script], { detached: true, stdio: "pipe" });
    owned.stdin.end();
    const descendantPid = await readyDescendantPid(owned.stdout);
    const manager = new DesktopBackendManager();
    manager.useOwnedServer(owned);

    await manager.close();

    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    await expect(waitUntilGone(descendantPid)).resolves.toBeUndefined();
  });
});

function readyDescendantPid(stdout: NodeJS.ReadableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("desktop backend fixture timed out")), 5_000);
    const parser = createReadyLineParser<{ descendantPid: number }>("READY ", (payload) => {
      clearTimeout(timer);
      resolve(payload.descendantPid);
    });
    stdout.on("data", (chunk) => parser.push(String(chunk)));
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
  throw new Error(`owned descendant ${pid} remained alive`);
}
