import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTerminalWebSocketHandler } from "../apps/server/src/runtime/terminal-sessions.js";
import { nativeTerminalCommand } from "../apps/server/src/runtime/native-agents/terminal-command.js";
import { runInNewContext } from "node:vm";
import { packagedTerminalSmokeExpression } from "../scripts/packaged-terminal-smoke.js";

const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);

// Mac login commands must survive slow shell startup and relocated zsh config.
// This uses the authenticated WebSocket and a real PTY, not simulated hook events.
it.skipIf(process.platform === "win32" || !zsh).each([
  { shell: zsh!, relocated: false },
  { shell: zsh!, relocated: true },
  { shell: "/bin/bash", relocated: false },
])("runs setup after shell startup ($shell, relocated: $relocated) and reports login failure", async ({ shell, relocated }) => {
  const home = await mkdtemp(join(tmpdir(), "native-setup-terminal-"));
  const config = relocated ? join(home, "config") : home;
  const bin = join(home, "bin");
  await mkdir(config, { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, ".zshenv"), relocated ? `export ZDOTDIR='${config}'\n` : "");
  const rc = `read -t 0.4 startup_input\nif [[ -n "$startup_input" ]]; then printf 'STARTUP_CONSUMED_COMMAND\\n'; fi\nexport PATH=/usr/bin:/bin\nPROMPT='setup> '\nPS1='setup> '\n`;
  await writeFile(join(config, ".zshrc"), rc);
  await writeFile(join(home, ".bashrc"), rc);
  await writeFile(join(bin, "claude"), "#!/bin/sh\nprintf 'LOGIN_FAILURE_VISIBLE\\n'\nexit 17\n", { mode: 0o700 });
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZDOTDIR", home);
  vi.stubEnv("OPENPOND_TERMINAL_SHELL", shell);
  const http = createServer();
  let port = 0;
  const terminal = createTerminalWebSocketHandler({
    host: "127.0.0.1", getActualPort: () => port, token: "fixture-token",
    logger: { info() {}, warn() {}, error() {} }, defaultCwdForApp: () => home,
  });
  http.on("upgrade", (request, socket, head) => terminal.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/terminal`, ["openpond-terminal", `openpond-token.${Buffer.from("fixture-token").toString("base64url")}`]);
  const messages: Array<Record<string, unknown>> = [];
  const command = nativeTerminalCommand("claude", ["auth", "login"], { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: home });
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error(`Login did not finish: ${JSON.stringify(messages)}`)), 8000);
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (message.type === "ready") socket.send(JSON.stringify({ type: "input", terminalId: "login", data: `${command}\n`, waitForPrompt: true }));
    if (message.type === "command_end") finish();
    if (message.type === "error") fail(new Error(message.message));
  };
  socket.onerror = () => fail(new Error("Terminal WebSocket failed"));
  try {
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true }); });
    socket.send(JSON.stringify({ type: "start", terminalId: "login", scope: { kind: "draft", id: "setup" }, cwd: home }));
    await ended;
    expect(messages.find(message => message.type === "command_start")?.command).toBe(command);
    expect(messages.find(message => message.type === "command_end")?.exitCode).toBe(17);
    const output = messages.filter(message => message.type === "output").map(message => message.data).join("");
    expect(output).toContain("LOGIN_FAILURE_VISIBLE");
    expect(output).not.toContain("STARTUP_CONSUMED_COMMAND");
    expect(messages.findIndex(message => message.type === "prompt_ready")).toBeLessThan(messages.findIndex(message => message.type === "command_start"));
    // The release gate must exercise the same PTY path and wait for a real
    // successful command, rather than accepting an echoed input line.
    const proof = await runInNewContext(packagedTerminalSmokeExpression, {
      window: { openpond: { getConnection: async () => ({ serverUrl: `http://127.0.0.1:${port}`, token: "fixture-token", platform: process.platform }) } },
      URL, TextEncoder, btoa, WebSocket, crypto, setTimeout, clearTimeout,
    });
    expect(proof).toEqual({ spawned: true, commandCompleted: true, outputReceived: true });
  } finally {
    clearTimeout(timer);
    socket.close();
    terminal.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
