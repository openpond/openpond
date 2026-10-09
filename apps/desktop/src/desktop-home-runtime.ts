import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isCompatibleDesktopServer, stopStaleLocalDesktopServer, type DesktopServerHealth } from "./desktop-server-compatibility.js";

const execute = promisify(execFile);
type RuntimeEndpoint = { schemaVersion?: string; pid?: number; url?: string; serverId?: string };

/** Recover the registered home owner, never an arbitrary listener on the default port. */
export async function recoverDesktopHomeRuntime(input: {
  home: string;
  desktopVersion: string;
  token: string | null;
  platform?: NodeJS.Platform;
  log?: (message: string, context: Record<string, unknown>) => void;
}): Promise<{ serverUrl: string; token: string } | null> {
  const owner = await readRecord<{ pid?: number; nonce?: string }>(path.join(input.home, "runtime", "server-owner.lock"));
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || !processAlive(owner.pid!)) return null;
  const pid = owner.pid!;
  const help = `An OpenPond runtime already owns ${input.home} (PID ${pid}). Quit the existing OpenPond app or stop that runtime, then click Retry. Your data has been preserved.`;
  const endpoint = await readRecord<RuntimeEndpoint>(path.join(input.home, "runtime", "endpoint.json"));
  const serverUrl = verifiedEndpointUrl(endpoint, pid);
  if (!serverUrl || !input.token) throw new Error(help);
  const request = (route: string, authenticated = false) => fetch(`${serverUrl}${route}`, {
    signal: AbortSignal.timeout(5_000), redirect: "error",
    ...(authenticated ? { headers: { Authorization: `Bearer ${input.token}` } } : {}),
  });
  let health: DesktopServerHealth;
  try {
    const response = await request("/health");
    if (!response.ok) throw new Error("Runtime health check failed.");
    health = await response.json() as DesktopServerHealth;
    if (!health.ok || health.server !== "openpond-app-server") throw new Error("Unexpected runtime.");
    const authenticated = await request(health.recovery ? "/v1/recovery" : "/v1/configuration", true);
    await authenticated.body?.cancel();
    if (!authenticated.ok) throw new Error("Runtime authentication failed.");
  } catch {
    throw new Error(help);
  }

  if ((input.platform ?? process.platform) === "darwin" && await isOrphanedMacDesktopServer(pid)) {
    // Recheck the home owner before signaling. Never retire a CLI runtime or a live app's backend.
    const current = await readRecord<{ pid?: number; nonce?: string }>(path.join(input.home, "runtime", "server-owner.lock"));
    if (current?.pid !== pid || current.nonce !== owner.nonce) throw new Error("OpenPond runtime ownership changed. Click Retry.");
    const retirement = await stopStaleLocalDesktopServer(serverUrl, { expectedPid: pid });
    if (!retirement.stopped) throw new Error(help);
    input.log?.("retired orphaned desktop home runtime", { pid, serverUrl, serverVersion: health.version });
    return null;
  }
  if (!isCompatibleDesktopServer(health, input.desktopVersion)) {
    throw new Error(`The existing OpenPond runtime is version ${health.version ?? "unknown"}; this app is ${input.desktopVersion}. ${help}`);
  }
  const renderer = await request("");
  const rendererAvailable = renderer.ok && renderer.headers.get("content-type")?.includes("text/html");
  await renderer.body?.cancel();
  if (!rendererAvailable) throw new Error(`The existing OpenPond runtime does not serve the desktop interface. ${help}`);
  input.log?.("reusing registered desktop home runtime", { pid, serverUrl });
  return { serverUrl, token: input.token };
}

export function verifiedEndpointUrl(endpoint: RuntimeEndpoint | null, ownerPid: number): string | null {
  if (endpoint?.schemaVersion !== "openpond.runtimeEndpoint.v1" || endpoint.pid !== ownerPid || !endpoint.serverId || !endpoint.url) return null;
  try {
    const url = new URL(endpoint.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

async function isOrphanedMacDesktopServer(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execute("/bin/ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], { timeout: 3_000 });
    return isOrphanedMacDesktopCommand(stdout);
  } catch { return false; }
}

export function isOrphanedMacDesktopCommand(output: string): boolean {
  // ps prints the parent PID followed by argv; matching both paths ties the server to one app bundle.
  return /^\s*1\s+(.+?\.app)\/Contents\/MacOS\/[^\n]+ \1\/Contents\/Resources\/server\/index\.js web(?: |$)/i.test(output);
}

async function readRecord<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
