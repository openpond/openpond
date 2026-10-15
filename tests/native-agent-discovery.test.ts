import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { nativeAgentLaunch } from "../apps/server/src/runtime/native-agents/config.js";
import { probeNativeAgent } from "../apps/server/src/runtime/native-agents/setup.js";
import { resolveLocalExecutablePath } from "../packages/runtime/src/executable-search-path.js";

const execute = promisify(execFile);
const fixtures: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "openpond-cli-discovery-"));
  fixtures.push(home);
  vi.stubEnv("HOME", home);
  for (const key of ["NVM_DIR", "FNM_DIR", "MISE_DATA_DIR", "ASDF_DATA_DIR", "NODENV_ROOT", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "npm_config_prefix", "NPM_CONFIG_PREFIX", "NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) vi.stubEnv(key, undefined);
  vi.stubEnv("PATH", "/usr/bin:/bin");
  return home;
}

async function launcher(home: string, relative: string) {
  const directory = path.join(home, relative);
  await mkdir(directory, { recursive: true });
  await symlink(process.execPath, path.join(directory, "node"));
  const executable = path.join(directory, "claude");
  // Actual subprocess boundary: a Node launcher needs its version manager's
  // runtime, and native setup must not submit a paid prompt while probing.
  await writeFile(executable, '#!/usr/bin/env node\n' + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.300'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 fs.appendFileSync(process.env.DISCOVERY_TRACE, value.type+'\n');
 if (value.type !== 'control_request') process.exit(9);
 process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{models:[{value:'fixture-model',displayName:'Fixture model'}]}}})+'\n');
});`, { mode: 0o755 });
  return executable;
}

describe.skipIf(process.platform === "win32")("native installer discovery", () => {
  // Failure story: desktop PATH setup does not cover a separately running
  // server or a newly created version-manager directory. Verify auth/models
  // from the server's real launch boundary, with no executable override.
  test.each([
    ".local/bin", ".claude/local", ".claude/local/node_modules/.bin", ".nvm/versions/node/v24.1.0/bin", ".local/share/fnm/node-versions/v24.1.0/installation/bin",
    "Library/Application Support/fnm/node-versions/v24.1.0/installation/bin",
    ".local/share/mise/installs/node/24.1.0/bin", ".asdf/installs/nodejs/24.1.0/bin", ".nodenv/versions/24.1.0/bin",
    "n/n/versions/node/24.1.0/bin", "Library/pnpm", "custom npm prefix/bin",
  ])("launches Claude from %s without inheriting its directory on PATH", async relative => {
    const home = await fixture();
    const trace = path.join(home, "trace");
    vi.stubEnv("DISCOVERY_TRACE", trace);
    const shell = path.join(home, "shell");
    await writeFile(shell, '#!/bin/sh\nprintf "__OPENPOND_EXECUTABLE_PATH__%s\\0" "$PATH"\n', { mode: 0o755 });
    vi.stubEnv("SHELL", shell);
    if (relative.startsWith("custom npm")) await writeFile(path.join(home, ".npmrc"), 'prefix=${HOME}/custom npm prefix\n//registry.npmjs.org/:_authToken=never-import-this\n');
    const executable = await launcher(home, relative);
    const result = await probeNativeAgent("claude-code", { sourceHome: path.join(home, ".claude") }, { force: true });
    expect(result.status, result.error ?? "").toBe("ready");
    expect(result.session?.models?.availableModels.map(model => model.modelId)).toEqual(["fixture-model"]);
    const launch = nativeAgentLaunch("claude-code");
    expect(launch.command).toBe(executable);
    expect((await execute("node", ["-p", "process.execPath"], { env: launch.env })).stdout.trim()).toBe(process.execPath);
    expect((await readFile(trace, "utf8")).trim()).toBe("control_request");
    expect(process.env.PATH).not.toContain("never-import-this");
    // Explicit overrides must remain authoritative, even if they are missing.
    expect(nativeAgentLaunch("claude-code", { binaryPath: path.join(home, "missing") }).command).toBe(path.join(home, "missing"));
  });

  test("picks up new version-manager installations between checks", async () => {
    const home = await fixture();
    const before = nativeAgentLaunch("claude-code");
    const executable = await launcher(home, ".local/share/mise/installs/node/99.0.0/bin");
    const after = nativeAgentLaunch("claude-code");
    expect(after.command).toBe(executable);
    expect(after.instanceId).not.toBe(before.instanceId);
    expect((await execute(after.command, ['--version'], { env: after.env })).stdout.trim()).toBe("2.1.300");
  });

  test("falls back to another login shell when the configured shell fails", async () => {
    const home = await fixture();
    const executable = await launcher(home, "custom-shell-tools");
    const shell = path.join(home, "working-shell");
    await writeFile(shell, `#!/bin/sh\nprintf 'startup noise\\n__OPENPOND_EXECUTABLE_PATH__%s\\0logout noise\\n' '${path.dirname(executable)}:/usr/bin:/bin'\n`, { mode: 0o755 });
    const searchPath = await resolveLocalExecutablePath({ home, env: { HOME: home, PATH: "/usr/bin:/bin" }, shellCandidates: [path.join(home, "missing-shell"), shell] });
    expect((await execute("claude", ["--version"], { env: { PATH: searchPath } })).stdout.trim()).toBe("2.1.300");
    expect(searchPath).not.toContain("noise");
  });
});
