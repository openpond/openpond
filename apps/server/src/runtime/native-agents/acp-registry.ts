import { z } from "zod";
import type { AcpAgentConfig } from "@openpond/contracts/providers";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(20000)).default({});
const args = z.array(z.string().max(4096)).max(100).default([]);
const packageDistribution = z.object({ package: z.string().min(1).max(300), args, env });
const binaryDistribution = z.object({ archive: z.string().url(), cmd: z.string().min(1).max(4096), args, env, sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() });
export const AcpRegistryAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,100}$/), name: z.string().min(1).max(160),
  version: z.string().min(1).max(200), description: z.string().max(10000).default(""),
  website: z.string().url().optional(), repository: z.string().url().optional(),
  distribution: z.object({ binary: z.record(z.string(), binaryDistribution).optional(), npx: packageDistribution.optional(), uvx: packageDistribution.optional() }),
});
export type AcpRegistryAgent = z.infer<typeof AcpRegistryAgentSchema>;
export type AcpDistribution = { kind: "binary"; spec: z.infer<typeof binaryDistribution> } | { kind: "npx" | "uvx"; spec: z.infer<typeof packageDistribution> };
export const acpPlatform = () => `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
export function chooseAcpDistribution(agent: AcpRegistryAgent, kind?: string, platform = acpPlatform()): AcpDistribution | null {
  const binary = agent.distribution.binary?.[platform];
  if ((!kind || kind === "binary") && binary) return { kind: "binary", spec: binary };
  if ((!kind || kind === "npx") && agent.distribution.npx) return { kind: "npx", spec: agent.distribution.npx };
  if ((!kind || kind === "uvx") && agent.distribution.uvx) return { kind: "uvx", spec: agent.distribution.uvx };
  return null;
}
type RegistryCache = { agents: AcpRegistryAgent[]; fetchedAt: string; expires: number };
let cached: RegistryCache | null = null;
let pending: Promise<RegistryCache> | null = null;
/** Fetch only metadata. No commands execute until an explicit registration/connect. */
export async function fetchAcpRegistry(force = false) {
  if (!force && cached && cached.expires > Date.now()) return cached;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`ACP registry returned ${response.status}.`);
    const bytes = await readBoundedResponse(response, 4 * 1024 * 1024);
    const document = z.object({ agents: z.array(z.unknown()).max(1000) }).parse(JSON.parse(bytes.toString("utf8")));
    const agents = document.agents.flatMap(value => { const parsed = AcpRegistryAgentSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
    if (!agents.length) throw new Error("ACP registry contains no supported entries.");
    cached = { agents, fetchedAt: new Date().toISOString(), expires: Date.now() + 10 * 60_000 };
    return cached;
  })();
  try { return await pending; } finally { pending = null; }
}
export async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("Download has no content.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new Error("Download exceeds the supported size."); chunks.push(next.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export function acpPackageLaunch(agent: AcpRegistryAgent, distribution: Exclude<AcpDistribution, { kind: "binary" }>): AcpAgentConfig {
  const spec = distribution.spec;
  const packageName = distribution.kind === "uvx" ? spec.package.replace(/@(\d)/, "==$1") : spec.package;
  // Package selectors are arguments, never shell commands. Pin immutable versions.
  const valid = distribution.kind === "npx"
    ? /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9_.-]+)?$/.test(packageName)
    : /^[a-zA-Z0-9_.-]+==\d+(?:\.\d+)+(?:[a-zA-Z0-9_.-]*)$/.test(packageName);
  if (!valid) throw new Error("This registry package is not version-pinned. Use a custom command for this agent.");
  return { displayName: agent.name, command: distribution.kind, args: [...(distribution.kind === "npx" ? ["--yes"] : []), packageName, ...spec.args], env: spec.env,
    registryId: agent.id, version: agent.version, installUrl: agent.website ?? agent.repository ?? null, authMethodId: null };
}
