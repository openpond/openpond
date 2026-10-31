import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const externalClientVersions = { codex: "0.153.4", opencode: "1.14.48" } as const;
export type ExternalCaptureClient = keyof typeof externalClientVersions;
export async function externalCaptureVersion(client: ExternalCaptureClient) {
  const { stdout } = await promisify(execFile)(client, ["--version"], { timeout: 10000, maxBuffer: 65536 });
  const version = client === "codex" ? stdout.trim().replace(/^codex-cli\s+/, "") : stdout.trim();
  if (version !== externalClientVersions[client])
    throw new Error(`This capture adapter supports ${client} ${externalClientVersions[client]}. Qualify the installed hook protocol before connecting another version.`);
  return version;
}
