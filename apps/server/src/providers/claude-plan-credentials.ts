import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { record } from "./plan-usage-normalization.js";
import type { nativeAgentLaunch } from "../runtime/native-agents/config.js";

/** Read only: the native CLI owns login, renewal, and credential storage. */
export async function readClaudePlanCredentials(launch: ReturnType<typeof nativeAgentLaunch>, configuredHome?: string | null): Promise<{ token: string; expiresAt: number | null } | null> {
  let raw: string | undefined;
  if (process.platform === "darwin") {
    // Use the original CLI storage namespace: nativeAgentLaunch always injects
    // CLAUDE_CONFIG_DIR, even when the user's ordinary login uses the default.
    const directory = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (configuredHome || process.env.CLAUDE_CONFIG_DIR);
    const suffix = directory ? `-${createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8)}` : "";
    const username = process.env.USER || userInfo().username;
    try {
      ({ stdout: raw } = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-a", /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user", "-w", "-s", `Claude Code-credentials${suffix}`], { timeout: 5_000, maxBuffer: 64 * 1024 }));
    } catch (error) {
      if (record(error).code !== 44) throw new Error("Claude login storage could not be read.");
    }
  }
  // Claude also supports file-backed login storage, including on macOS when
  // there is no Keychain entry. Never look outside the configured source home.
  if (raw === undefined) {
    try { raw = await readFile(join(launch.sourceHome, ".credentials.json"), "utf8"); }
    catch (error) {
      if (record(error).code === "ENOENT") return null;
      throw new Error("Claude login storage could not be read.");
    }
  }
  const oauth = record(record(JSON.parse(raw)).claudeAiOauth);
  return typeof oauth.accessToken === "string" && oauth.accessToken
    ? { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null }
    : null;
}
