import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  { shell: zsh!, relocated: false, answer: undefined, direct: false, exitCode: 17 },
  { shell: zsh!, relocated: true, answer: undefined, direct: false, exitCode: 17 },
  { shell: "/bin/bash", relocated: false, answer: undefined, direct: false, exitCode: 17 },
  { shell: zsh!, relocated: false, answer: "n", direct: false, exitCode: 17 },
  { shell: zsh!, relocated: true, answer: "y", direct: false, exitCode: 17 },
  { shell: zsh!, relocated: true, answer: undefined, direct: true, exitCode: 0 },
  { shell: zsh!, relocated: false, answer: undefined, direct: true, exitCode: 17 },
])("runs setup after shell startup ($shell, relocated: $relocated, update: $answer) and reports login exit $exitCode (direct: $direct)", async ({ shell, relocated, answer, direct, exitCode }) => {
  const home = await mkdtemp(join(tmpdir(), "native-setup-terminal-"));
  const config = relocated ? join(home, "config") : home;
  const bin = join(home, "bin");
  await mkdir(config, { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, ".zshenv"), relocated ? `export ZDOTDIR='${config}'\n` : "");
  const rc = `read -t 0.4 startup_input\nif [[ -n "$startup_input" ]]; then printf 'STARTUP_CONSUMED_COMMAND\\n'; fi\nexport PATH=/usr/bin:/bin\nPROMPT='setup> '\nPS1='setup> '\n`;
  const updatePrompt = answer ? `printf 'UPDATE_ANSWER_REQUIRED\\n'
read startup_answer
if [[ "$startup_answer" != "${answer}" ]]; then printf 'STARTUP_CONSUMED_COMMAND\\n'; fi
if [[ "$startup_answer" == "y" ]]; then sleep 0.2; fi
` : "";
  await writeFile(join(config, ".zshrc"), (direct ? "printf 'SHELL_STARTUP_RAN\\n'\n" : "") + updatePrompt + rc);
  await writeFile(join(home, ".bashrc"), rc);
  // Direct setup must retain discovered PATH/account settings, accept user
  // input, and report process exit without depending on shell startup hooks.
  await writeFile(join(bin, "claude"), `#!/bin/sh
printf '%s\\n' "$PATH" "$CLAUDE_CONFIG_DIR" "$@" > "$CLAUDE_CONFIG_DIR/launch"
${direct ? "printf 'LOGIN_INPUT_REQUIRED\\n'\nread login_answer\n[ \"$login_answer\" = continue ] || exit 19" : ""}
printf 'LOGIN_PROCESS_FINISHED\\n'
exit ${exitCode}
`, { mode: 0o700 });
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZDOTDIR", home);
  vi.stubEnv("OPENPOND_TERMINAL_SHELL", shell);
  const http = createServer();
  let port = 0;
  const terminal = createTerminalWebSocketHandler({
    host: "127.0.0.1", getActualPort: () => port, token: "fixture-token",
    logger: { info() {}, warn() {}, error() {} }, defaultCwdForApp: () => direct ? tmpdir() : home,
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
  let answered = false;
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (answer && !answered && messages.filter(item => item.type === "output").map(item => item.data).join("").includes("UPDATE_ANSWER_REQUIRED")) {
      answered = true;
      socket.send(JSON.stringify({ type: "input", terminalId: "login", data: `${answer}\n` }));
    }
    if (direct && !answered && messages.filter(item => item.type === "output").map(item => item.data).join("").includes("LOGIN_INPUT_REQUIRED")) {
      answered = true;
      socket.send(JSON.stringify({ type: "input", terminalId: "login", data: "continue\n" }));
    }
    if (!direct && message.type === "ready") socket.send(JSON.stringify({ type: "input", terminalId: "login", data: `${command}\n`, waitForPrompt: true }));
    if (message.type === "command_end") finish();
    if (message.type === "error") fail(new Error(message.message));
  };
  socket.onerror = () => fail(new Error("Terminal WebSocket failed"));
  try {
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true }); });
    socket.send(JSON.stringify({ type: "start", terminalId: "login", scope: { kind: "draft", id: "setup" }, cwd: direct ? null : home, ...(direct ? { setup: { command, displayCommand: "claude auth login" } } : {}) }));
    await ended;
    expect(messages.find(message => message.type === "command_start")?.command).toBe(direct ? "claude auth login" : command);
    expect(messages.find(message => message.type === "command_end")?.exitCode).toBe(exitCode);
    const output = messages.filter(message => message.type === "output").map(message => message.data).join("");
    expect(output).toContain("LOGIN_PROCESS_FINISHED");
    expect(output).not.toContain("STARTUP_CONSUMED_COMMAND");
    if (direct) {
      expect(messages.find(message => message.type === "ready")?.cwd).toBe(home);
      expect(output).not.toContain("SHELL_STARTUP_RAN");
      expect(output).not.toContain(command);
      expect(output).not.toContain("env '");
      expect(output).toContain("claude auth login");
      expect((await readFile(join(home, "launch"), "utf8")).trim().split("\n")).toEqual([`${bin}:/usr/bin:/bin`, home, "auth", "login"]);
    } else {
      expect(messages.findIndex(message => message.type === "prompt_ready")).toBeLessThan(messages.findIndex(message => message.type === "command_start"));
    }
    // The release gate must exercise the same PTY path and wait for a real
    // successful command, rather than accepting an echoed input line.
    if (!answer && !direct) {
      const proof = await runInNewContext(packagedTerminalSmokeExpression, {
        window: { openpond: { getConnection: async () => ({ serverUrl: `http://127.0.0.1:${port}`, token: "fixture-token", platform: process.platform }) } },
        URL, TextEncoder, btoa, WebSocket, crypto, setTimeout, clearTimeout,
      });
      expect(proof).toEqual({ spawned: true, commandCompleted: true, outputReceived: true });
    }
  } finally {
    clearTimeout(timer);
    socket.close();
    terminal.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
