import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpSessionResult } from "@openpond/agent-runtime";
import type { NativeAgentId } from "./config.js";

const registryPath = (sourceHome: string) => join(sourceHome, ".openpond", "capability-probe-sessions");
export const nativeCapabilityProbeKey = (provider: NativeAgentId, sessionId: string) =>
  createHash("sha256").update(JSON.stringify([provider, sessionId])).digest("hex");

/** ACP catalogs require session/new. These exact identities are never user chats. */
export async function createNativeCapabilityProbe(provider: NativeAgentId, sourceHome: string,
  create: () => Promise<AcpSessionResult>): Promise<AcpSessionResult> {
  await mkdir(join(sourceHome, ".openpond"), { recursive: true, mode: 0o700 });
  // Open before creating a native session: a read-only profile cannot leave an
  // untracked probe behind. Append preserves concurrent processes' identities.
  const handle = await open(registryPath(sourceHome), "a", 0o600);
  try {
    const session = await create();
    await handle.writeFile(`${nativeCapabilityProbeKey(provider, session.sessionId)}\n`);
    await handle.sync();
    return session;
  } finally { await handle.close(); }
}

export async function nativeCapabilityProbeKeys(sourceHome: string): Promise<Set<string>> {
  let content: string;
  try { content = await readFile(registryPath(sourceHome), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw error; }
  const keys = content.split("\n").filter(Boolean);
  if (keys.some((key) => !/^[a-f0-9]{64}$/.test(key))) throw new Error("Native capability probe registry is invalid.");
  return new Set(keys);
}
