import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPlanUsageService } from "../apps/server/src/providers/plan-usage-service.js";
import { nativeAgentLaunch } from "../apps/server/src/runtime/native-agents/config.js";

const keychain = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execute = promisify(original.execFile);
  return { ...original, execFile: Object.assign(original.execFile.bind(null), {
    [promisify.custom]: (command: string, args: string[], options: object) => command === "/usr/bin/security"
      ? keychain(command, args, options) : execute(command, args, options),
  }) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixtures: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  keychain.mockReset();
  await Promise.all(fixtures.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "claude-login-store-"));
  fixtures.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USER", "claude-test-user");
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
  return home;
}

const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3600000 } });

// Failure story: macOS can authenticate a CLI from one Keychain namespace but
// read usage from another, hiding real limits or displaying a different account.
test.each(["default", "configured", "inherited", "secure", "empty-secure"] as const)("uses the launched Claude account for macOS usage (%s)", async mode => {
  const home = await fixture();
  Object.defineProperty(process, "platform", { value: "darwin" });
  const config = mode === "default" || mode === "inherited" ? undefined : { sourceHome: join(home, "profile") };
  if (mode === "inherited") vi.stubEnv("CLAUDE_CONFIG_DIR", `${home}/e\u0301-profile/`);
  if (mode === "secure") vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", join(home, "login"));
  if (mode === "empty-secure") vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");
  const directory = mode === "default" || mode === "empty-secure" ? ""
    : mode === "inherited" ? process.env.CLAUDE_CONFIG_DIR!
    : mode === "secure" ? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR! : config!.sourceHome;
  const serviceName = `Claude Code-credentials${directory ? `-${createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8)}` : ""}`;
  keychain.mockImplementation(async (_command, args) => {
    expect(args).toEqual(["find-generic-password", "-a", "claude-test-user", "-w", "-s", serviceName]);
    return { stdout: credentials("account-secret") };
  });
  const fetcher = vi.fn(async () => Response.json({ five_hour: { utilization: 28 }, seven_day: { utilization: 5 } }));
  vi.stubGlobal("fetch", fetcher);
  const launch = nativeAgentLaunch("claude-code", config);
  if (mode === "default") expect(launch.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  if (mode === "inherited") expect(launch.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  const result = await createPlanUsageService()("claude-code", config);
  expect(result.status).toBe("ready");
  expect(result.windows.map(window => window.remainingPercent)).toEqual([72, 95]);
  expect(fetcher).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer account-secret" }) }));
  expect(JSON.stringify(result)).not.toContain("secret");
});

// File fallback must obey the same account selection, including a locked
// Keychain. Never use a token from the conversation home of another account.
test.each(["darwin", "linux"])("reads the selected secure-storage file on %s", async target => {
  const home = await fixture();
  Object.defineProperty(process, "platform", { value: target });
  const sourceHome = join(home, "conversations");
  const loginHome = join(home, "login");
  await mkdir(sourceHome);
  await mkdir(loginHome);
  await writeFile(join(sourceHome, ".credentials.json"), credentials("wrong-account"));
  await writeFile(join(loginHome, ".credentials.json"), credentials("selected-account"));
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", loginHome);
  keychain.mockRejectedValue(Object.assign(new Error("private keychain details"), { code: 36 }));
  const fetcher = vi.fn(async () => Response.json({ five_hour: { utilization: 10 } }));
  vi.stubGlobal("fetch", fetcher);
  const service = createPlanUsageService();
  expect((await service("claude-code", { sourceHome })).status).toBe("ready");
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer selected-account" }) }));
  await rm(join(loginHome, ".credentials.json"));
  const missing = await service("claude-code", { sourceHome });
  expect(missing.status).toBe(target === "darwin" ? "unavailable" : "signed_out");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(missing)).not.toContain("private");
  if (target === "darwin") {
    keychain.mockRejectedValue(Object.assign(new Error("item not found"), { code: 44 }));
    expect((await service("claude-code", { sourceHome })).status).toBe("signed_out");
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test("invalidates native readiness when the credential namespace changes", async () => {
  await fixture();
  const initial = nativeAgentLaunch("claude-code");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(homedir(), ".claude"));
  const explicit = nativeAgentLaunch("claude-code");
  expect(explicit.sourceHome).toBe(initial.sourceHome);
  expect(explicit.instanceId).not.toBe(initial.instanceId);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");
  expect(nativeAgentLaunch("claude-code").instanceId).not.toBe(explicit.instanceId);
});
