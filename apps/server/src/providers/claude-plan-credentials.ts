import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { record } from "./plan-usage-normalization.js";
import type { nativeAgentLaunch } from "../runtime/native-agents/config.js";

/** Read only: the native CLI owns login, renewal, and credential storage. */
export async function readClaudePlanCredentials(launch: ReturnType<typeof nativeAgentLaunch>): Promise<{ token: string; expiresAt: number | null } | null> {
  let raw: string | undefined;
  let storageError = false;
  const directory = launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? launch.env.CLAUDE_CONFIG_DIR;
  const credentialHome = launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined
    ? launch.sourceHome : resolve(directory || join(homedir(), ".claude"));
  if (process.platform === "darwin") {
    // Hash the exact namespace passed to the CLI, including an explicit empty
    // secure-storage override, which selects the default Keychain item.
    const suffix = directory ? `-${createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8)}` : "";
    const username = launch.env.USER || userInfo().username;
    try {
      ({ stdout: raw } = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-a", /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user", "-w", "-s", `Claude Code-credentials${suffix}`], { timeout: 5_000, maxBuffer: 64 * 1024 }));
    } catch (error) {
      storageError = record(error).code !== 44;
    }
  }
  // Claude also supports file-backed login storage, including on macOS when
  // the Keychain is unavailable. Use only the CLI's selected credential home.
  if (raw === undefined) {
    try { raw = await readFile(join(credentialHome, ".credentials.json"), "utf8"); }
    catch (error) {
      if (record(error).code === "ENOENT" && !storageError) return null;
      throw new Error("Claude login storage could not be read.");
    }
  }
  const oauth = record(record(JSON.parse(raw)).claudeAiOauth);
  return typeof oauth.accessToken === "string" && oauth.accessToken
    ? { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null }
    : null;
}
