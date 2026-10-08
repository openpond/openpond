import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import bunzip from "unbzip2-stream";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { t, x } from "tar";
import { unzipSync } from "fflate";
import type { AcpAgentConfig } from "@openpond/contracts/providers";
import { acpPackageLaunch, chooseAcpDistribution, readBoundedResponse, type AcpRegistryAgent } from "./acp-registry.js";

const MAX_EXPANDED = 1024 * 1024 * 1024;
/** Archive paths cannot escape staging; links/devices are never installed. */
export function acpArchivePath(root: string, name: string): string {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) throw new Error("ACP archive contains an unsafe path.");
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("ACP archive path escapes installation.");
  return target;
}
export async function installAcpAgent(home: string, agent: AcpRegistryAgent, kind?: string): Promise<AcpAgentConfig> {
  const distribution = chooseAcpDistribution(agent, kind);
  if (!distribution) throw new Error("No supported distribution for this platform. Use a custom command.");
  if (distribution.kind !== "binary") return acpPackageLaunch(agent, distribution);
  const spec = distribution.spec;
  if (new URL(spec.archive).protocol !== "https:") throw new Error("ACP downloads must use HTTPS.");
  const key = createHash("sha256").update(JSON.stringify([agent.id, agent.version, spec])).digest("hex");
  const parent = join(home, "runtime", "acp-agents"); const destination = join(parent, key);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const receipt = join(destination, ".openpond-install.json");
  try { const prior = JSON.parse(await readFile(receipt, "utf8")); if (prior.key === key) return prior.config; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = await mkdtemp(join(parent, ".install-"));
  try {
    const response = await fetch(spec.archive, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`ACP download returned ${response.status}.`);
    const bytes = await readBoundedResponse(response, 256 * 1024 * 1024);
    if (spec.sha256 && createHash("sha256").update(bytes).digest("hex") !== spec.sha256.toLowerCase()) throw new Error("ACP archive checksum does not match the registry.");
    const unpack = join(stage, "contents"); await mkdir(unpack);
    let expanded = 0; let entries = 0;
    const accept = (name: string, size: number) => { acpArchivePath(unpack, name); expanded += size; if (expanded > MAX_EXPANDED || ++entries > 20000) throw new Error("ACP archive exceeds installation limits."); };
    if (new URL(spec.archive).pathname.endsWith(".zip")) {
      const files = unzipSync(bytes, { filter: file => { accept(file.name, file.originalSize); return true; } });
      for (const [name, content] of Object.entries(files)) {
        const target = acpArchivePath(unpack, name);
        if (name.endsWith("/")) await mkdir(target, { recursive: true });
        else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { mode: 0o700, flag: "wx" }); }
      }
    } else if (/\.tar\.(gz|bz2)$|\.tgz$/.test(new URL(spec.archive).pathname)) {
      const archive = join(stage, "download.tar");
      if (new URL(spec.archive).pathname.endsWith(".bz2")) {
        let unpacked = 0;
        await pipeline(Readable.from([bytes]), bunzip(), new Transform({ transform(chunk: Buffer, _encoding, callback) {
          unpacked += chunk.length; callback(unpacked > MAX_EXPANDED ? new Error("ACP archive exceeds installation limits.") : null, chunk);
        } }), createWriteStream(archive, { mode: 0o600, flags: "wx" }));
      } else await writeFile(archive, bytes, { mode: 0o600 });
      let invalid: Error | null = null;
      await t({ file: archive, strict: true, onentry: entry => {
        try { accept(entry.path, entry.size); if (!["File", "Directory"].includes(entry.type)) throw new Error("ACP archives cannot contain links or special files."); }
        catch (error) { invalid = error as Error; }
      } });
      if (invalid) throw invalid;
      await x({ file: archive, cwd: unpack, strict: true, preservePaths: false, noChmod: true });
    } else {
      const filename = decodeURIComponent(new URL(spec.archive).pathname.split("/").at(-1) ?? "");
      if (filename !== spec.cmd.replace(/^\.\//, "")) throw new Error("Unsupported archive format. Use a custom command.");
      await writeFile(acpArchivePath(unpack, spec.cmd), bytes, { mode: 0o700, flag: "wx" });
    }
    const executable = acpArchivePath(unpack, spec.cmd); if (!(await lstat(executable)).isFile()) throw new Error("ACP archive does not contain the declared executable.");
    await chmod(executable, 0o700);
    const command = acpArchivePath(destination, spec.cmd);
    const config: AcpAgentConfig = { displayName: agent.name, command, args: spec.args, env: spec.env, registryId: agent.id, version: agent.version, installUrl: agent.website ?? agent.repository ?? null, authMethodId: null };
    await writeFile(join(unpack, ".openpond-install.json"), JSON.stringify({ key, config }), { mode: 0o600, flag: "wx" });
    try { await rename(unpack, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    return config;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
