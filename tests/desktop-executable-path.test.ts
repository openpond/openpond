import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initializeDesktopExecutablePath, resolveDesktopExecutablePath } from "../apps/desktop/src/desktop-executable-path.js";

const execute = promisify(execFile);
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
const fixtures: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "openpond-desktop-path-"));
  fixtures.push(home);
  for (const [directory, commands] of [[".local/bin", ["claude", "grok"]], [".bun/bin", ["codex", "opencode"]]] as const) {
    await mkdir(path.join(home, directory), { recursive: true });
    for (const command of commands) {
      await writeFile(path.join(home, directory, command), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(command)});\n`, { mode: 0o755 });
    }
  }
  return home;
}

async function expectAgentsLaunch(searchPath: string) {
  for (const command of ["claude", "codex", "grok", "opencode"]) {
    const { stdout } = await execute(command, ["--version"], { env: { PATH: searchPath }, timeout: 5_000 });
    expect(stdout.trim()).toBe(command);
  }
}

describe.skipIf(process.platform === "win32")("desktop executable discovery", () => {
  // Installing a native CLI after opening Providers must not require restarting
  // the app just because ~/.local/bin did not exist at desktop startup.
  test("discovers providers installed after the search path was initialized", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "openpond-late-install-"));
    fixtures.push(home);
    const searchPath = await resolveDesktopExecutablePath({ home, env: { HOME: home, SHELL: path.join(home, "missing-shell"), PATH: path.dirname(process.execPath) } });
    await mkdir(path.join(home, ".local", "bin"), { recursive: true });
    await writeFile(path.join(home, ".local", "bin", "claude"), '#!/usr/bin/env node\nconsole.log("claude");\n', { mode: 0o755 });
    const { stdout } = await execute("claude", ["--version"], { env: { PATH: searchPath }, timeout: 5_000 });
    expect(stdout.trim()).toBe("claude");
  });

  test.skipIf(process.platform !== "linux")("recovers native tools for a Linux desktop launch", async () => {
    const home = await fixture();
    const runtime = path.join(home, "runtime");
    await mkdir(runtime);
    await symlink(process.execPath, path.join(runtime, "node"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("BUN_INSTALL", path.join(home, ".bun"));
    vi.stubEnv("SHELL", path.join(home, "missing-shell"));
    vi.stubEnv("PATH", runtime);
    await initializeDesktopExecutablePath({ info() {} } as Parameters<typeof initializeDesktopExecutablePath>[0]);
    await expectAgentsLaunch(process.env.PATH!);
  });

  // Failure story: a GUI launch can find neither CLI wrappers nor the Node
  // interpreter they need, even though every provider works in a terminal.
  test.skipIf(!zsh)("loads macOS zsh profile and rc paths before launching all four agents", async () => {
    const home = await fixture();
    const runtime = path.join(home, "shell-runtime");
    await mkdir(runtime);
    await symlink(process.execPath, path.join(runtime, "node"));
    await writeFile(path.join(home, ".zprofile"), 'printf "profile startup noise\\n"\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin"\n');
    await writeFile(path.join(home, ".zshrc"), 'export PATH="$HOME/shell-runtime:$PATH"\nexport OPENPOND_PATH_TEST_SECRET=from_shell\n');
    await writeFile(path.join(home, ".zlogout"), 'printf "logout noise\\n"\n');
    const env = { HOME: home, ZDOTDIR: home, SHELL: zsh, PATH: "/usr/bin:/bin" };
    const searchPath = await resolveDesktopExecutablePath({ home, env });
    expect(searchPath.split(path.delimiter)[0]).toBe(runtime);
    expect(searchPath).not.toContain("noise");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env).not.toHaveProperty("OPENPOND_PATH_TEST_SECRET");
    await expectAgentsLaunch(searchPath);
  });

  test.each(["missing", "timeout"])("retains CLI and Node discovery when shell startup is %s", async (failure) => {
    const home = await fixture();
    const runtime = path.join(home, ".nvm", "versions", "node", "v24.18.0", "bin");
    await mkdir(runtime, { recursive: true });
    await symlink(process.execPath, path.join(runtime, "node"));
    const shell = path.join(home, "shell");
    if (failure === "timeout") await writeFile(shell, "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o755 });
    const searchPath = await resolveDesktopExecutablePath({ home, env: { HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" }, shellTimeoutMs: 50 });
    expect(searchPath.split(path.delimiter)).toContain(runtime);
    expect(new Set(searchPath.split(path.delimiter)).size).toBe(searchPath.split(path.delimiter).length);
    await expectAgentsLaunch(searchPath);
  });
});
