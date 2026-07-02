import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  RemoteAccessPeer,
  RemoteAccessServeState,
  RemoteAccessStatus,
  RemoteAccessTailscaleState,
  RemoteAccessToggleResponse,
} from "@openpond/contracts";
import { now } from "../utils.js";

type RemoteAccessLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

type TailscaleCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  notFound: boolean;
};

type EndpointMatch = {
  endpoint: string | null;
  targetUrl: string | null;
};

const TAILSCALE_COMMAND_TIMEOUT_MS = 6000;
const TAILSCALE_MUTATION_TIMEOUT_MS = 20000;
const TAILSCALE_MAX_BUFFER = 2 * 1024 * 1024;

function tailscaleBinary(): string {
  const explicit = process.env.TAILSCALE_BINARY?.trim();
  if (explicit) return explicit;
  return tailscaleBinaryCandidates().find((candidate) => existsSync(candidate)) ?? "tailscale";
}

function tailscaleBinaryCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
    ];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    return [
      programFiles ? `${programFiles}\\Tailscale\\tailscale.exe` : "",
      programFilesX86 ? `${programFilesX86}\\Tailscale\\tailscale.exe` : "",
    ].filter(Boolean);
  }
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/bin/tailscale", "/snap/bin/tailscale"];
}

function runTailscale(args: string[], timeoutMs = TAILSCALE_COMMAND_TIMEOUT_MS): Promise<TailscaleCommandResult> {
  return new Promise((resolve) => {
    execFile(
      tailscaleBinary(),
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: TAILSCALE_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const nodeError = error as (Error & { code?: string | number; signal?: string | null }) | null;
        resolve({
          code: typeof nodeError?.code === "number" ? nodeError.code : error ? 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          error: error ? nodeError?.message ?? String(error) : null,
          notFound: nodeError?.code === "ENOENT",
        });
      },
    );
  });
}

function commandError(result: TailscaleCommandResult): string | null {
  const message = result.stderr.trim() || result.stdout.trim() || result.error;
  return message ? message.replace(/\s+/g, " ").trim() : null;
}

function userFacingCommandError(result: TailscaleCommandResult): string | null {
  const raw = commandError(result);
  if (!raw) return null;
  if (/checkprefs access denied|sudo tailscale up|--operator/i.test(raw)) {
    return "Tailscale needs one-time local permission. Run `sudo tailscale set --operator=$USER`, then try Turn on again.";
  }
  return raw;
}

function authUrlFromCommand(result: TailscaleCommandResult): string | null {
  return /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/.exec(`${result.stdout}\n${result.stderr}`)?.[0] ?? null;
}

function urlFromText(value: string | null): string | null {
  return value ? /https?:\/\/[^\s"'<>]+/.exec(value)?.[0] ?? null : null;
}

function assertCommandOk(result: TailscaleCommandResult, fallback: string): void {
  if (result.code === 0 && !result.error) return;
  throw new Error(commandError(result) ?? fallback);
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function normalizeDnsName(value: unknown): string | null {
  const dnsName = stringValue(value);
  return dnsName ? dnsName.replace(/\.+$/, "") : null;
}

function normalizeTimestamp(value: unknown): string | null {
  const timestamp = stringValue(value);
  if (!timestamp || timestamp.startsWith("0001-01-01")) return null;
  return timestamp;
}

function parseTailscaleVersion(result: TailscaleCommandResult): string | null {
  if (result.notFound || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
}

function peerFromRecord(value: unknown, isSelf: boolean): RemoteAccessPeer | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = stringValue(record.ID) ?? stringValue(record.PublicKey) ?? (isSelf ? "self" : null);
  if (!id) return null;
  const hostName = stringValue(record.HostName);
  const dnsName = normalizeDnsName(record.DNSName);
  const name = hostName ?? dnsName ?? id;
  return {
    id,
    name,
    dnsName,
    os: stringValue(record.OS),
    online: booleanValue(record.Online),
    active: booleanValue(record.Active),
    isSelf,
    tailscaleIps: stringArray(record.TailscaleIPs),
    lastSeen: normalizeTimestamp(record.LastSeen),
  };
}

function tailscaleBaseUrl(state: Pick<RemoteAccessTailscaleState, "dnsName" | "machineName" | "magicDnsSuffix">): string | null {
  if (state.dnsName) return `https://${state.dnsName}`;
  if (state.machineName && state.magicDnsSuffix) return `https://${state.machineName}.${state.magicDnsSuffix}`;
  return null;
}

export function parseTailscaleStatusJson(
  value: unknown,
  version: string | null,
  error: string | null = null,
): RemoteAccessTailscaleState {
  const root = asRecord(value);
  const self = asRecord(root?.Self);
  const currentTailnet = asRecord(root?.CurrentTailnet);
  const backendState = stringValue(root?.BackendState);
  const selfPeer = peerFromRecord(self, true);
  const peers = [
    selfPeer,
    ...Object.values(asRecord(root?.Peer) ?? {}).map((peer) => peerFromRecord(peer, false)),
  ]
    .filter((peer): peer is RemoteAccessPeer => Boolean(peer))
    .sort((left, right) => {
      if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
      if (left.online !== right.online) return left.online ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return {
    installed: true,
    running: backendState === "Running",
    version,
    backendState,
    tailnetName: stringValue(currentTailnet?.Name),
    magicDnsSuffix: stringValue(root?.MagicDNSSuffix) ?? stringValue(currentTailnet?.MagicDNSSuffix),
    machineName: stringValue(self?.HostName),
    dnsName: normalizeDnsName(self?.DNSName),
    authUrl: stringValue(root?.AuthURL),
    tailscaleIps: stringArray(root?.TailscaleIPs).length > 0 ? stringArray(root?.TailscaleIPs) : stringArray(self?.TailscaleIPs),
    health: stringArray(root?.Health),
    error,
    peers,
  };
}

function unavailableTailscaleState(error: string | null): RemoteAccessTailscaleState {
  return {
    installed: false,
    running: false,
    version: null,
    backendState: null,
    tailnetName: null,
    magicDnsSuffix: null,
    machineName: null,
    dnsName: null,
    authUrl: null,
    tailscaleIps: [],
    health: [],
    error,
    peers: [],
  };
}

function endpointFromKey(key: string): { host: string; port: number } | null {
  const match = /^(.+):(\d+)$/.exec(key.trim());
  if (!match) return null;
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = match[1]!.replace(/^\[|\]$/g, "");
  return host ? { host, port } : null;
}

function valueContainsTarget(value: unknown, port: number): boolean {
  if (typeof value === "string") {
    return value.includes(`127.0.0.1:${port}`) || value.includes(`localhost:${port}`);
  }
  if (Array.isArray(value)) return value.some((item) => valueContainsTarget(item, port));
  const record = asRecord(value);
  return record ? Object.values(record).some((item) => valueContainsTarget(item, port)) : false;
}

function targetUrlFromValue(value: unknown, port: number): string | null {
  if (typeof value === "string" && valueContainsTarget(value, port)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = targetUrlFromValue(item, port);
      if (target) return target;
    }
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const [key, item] of Object.entries(record)) {
    if ((key.toLowerCase() === "proxy" || key.toLowerCase() === "target") && typeof item === "string" && valueContainsTarget(item, port)) {
      return item;
    }
    const target = targetUrlFromValue(item, port);
    if (target) return target;
  }
  return null;
}

function findEndpoint(value: unknown, port: number): EndpointMatch | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const [key, item] of Object.entries(record)) {
    const endpoint = endpointFromKey(key);
    if (endpoint && valueContainsTarget(item, port)) {
      return {
        endpoint: key,
        targetUrl: targetUrlFromValue(item, port),
      };
    }
    const nested = findEndpoint(item, port);
    if (nested) return nested;
  }
  return null;
}

function endpointUrl(endpoint: string | null, fallbackUrl: string | null): { url: string | null; host: string | null; port: number | null } {
  if (!endpoint) {
    const fallback = fallbackUrl ? new URL(fallbackUrl) : null;
    return {
      url: fallbackUrl,
      host: fallback?.hostname ?? null,
      port: fallback?.port ? Number.parseInt(fallback.port, 10) : fallback ? 443 : null,
    };
  }
  const parsed = endpointFromKey(endpoint);
  if (!parsed) return { url: fallbackUrl, host: null, port: null };
  return {
    url: `https://${parsed.host}${parsed.port === 443 ? "" : `:${parsed.port}`}`,
    host: parsed.host,
    port: parsed.port,
  };
}

export function parseTailscaleServeConfig(
  value: unknown,
  port: number,
  fallbackHttpsUrl: string | null,
  tailscaleRunning = true,
  error: string | null = null,
): RemoteAccessServeState {
  const root = asRecord(value);
  const hasConfig = Boolean(root && Object.keys(root).length > 0);
  const endpoint = root ? findEndpoint(root, port) : null;
  const fallbackTarget = root && valueContainsTarget(root, port) ? targetUrlFromValue(root, port) : null;
  const enabled = Boolean(endpoint || fallbackTarget);
  const url = endpointUrl(endpoint?.endpoint ?? null, enabled ? fallbackHttpsUrl : null);

  return {
    enabled,
    reachable: enabled && tailscaleRunning,
    targetUrl: endpoint?.targetUrl ?? fallbackTarget,
    httpsUrl: enabled ? url.url : null,
    httpsHost: enabled ? url.host : null,
    httpsPort: enabled ? url.port : null,
    setupUrl: urlFromText(error),
    configText: hasConfig ? JSON.stringify(root, null, 2) : null,
    error,
  };
}

function withTokenHash(baseUrl: string, tokenHash: string): string {
  const url = new URL(baseUrl);
  url.hash = tokenHash.startsWith("#") ? tokenHash.slice(1) : tokenHash;
  return url.toString();
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function createRemoteAccessManager({
  getActualPort,
  logger,
  token,
  webRoot,
  webTargetUrl,
}: {
  getActualPort: () => number;
  logger: RemoteAccessLogger;
  token: string;
  webRoot?: string | null;
  webTargetUrl?: string | null;
}) {
  function localBaseUrl(): string {
    return `http://127.0.0.1:${getActualPort()}`;
  }

  function remoteAccessTargetUrl(): string {
    const configured = normalizeHttpUrl(webTargetUrl);
    return configured ?? localBaseUrl();
  }

  function remoteAccessTargetPort(): number {
    const url = new URL(remoteAccessTargetUrl());
    if (url.port) return Number.parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  }

  function tokenHash(): string {
    return `#openpondToken=${encodeURIComponent(token)}`;
  }

  async function status(): Promise<RemoteAccessStatus> {
    const port = remoteAccessTargetPort();
    const localUrl = remoteAccessTargetUrl();
    const hash = tokenHash();
    const [versionResult, statusResult, serveResult] = await Promise.all([
      runTailscale(["version"]),
      runTailscale(["status", "--json"]),
      runTailscale(["serve", "status", "--json"]),
    ]);

    const tailscale = versionResult.notFound
      ? unavailableTailscaleState("Tailscale is not installed or not available on PATH.")
      : parseTailscaleStatusJson(
          parseJson(statusResult.stdout),
          parseTailscaleVersion(versionResult),
          statusResult.code === 0 ? null : commandError(statusResult),
        );
    const candidateRemoteUrl = tailscaleBaseUrl(tailscale);
    const serve = versionResult.notFound
      ? parseTailscaleServeConfig(null, port, null, false, "Tailscale is not installed or not available on PATH.")
      : parseTailscaleServeConfig(
          parseJson(serveResult.stdout),
          port,
          candidateRemoteUrl,
          tailscale.running,
          serveResult.code === 0 ? null : commandError(serveResult),
        );
    const remoteUrl = serve.httpsUrl ?? candidateRemoteUrl;

    return {
      localUrl,
      localWebUrl: withTokenHash(localUrl, hash),
      remoteUrl,
      remoteWebUrl: remoteUrl ? withTokenHash(remoteUrl, hash) : null,
      tokenHash: hash,
      tailscaleUpCommand: `sudo ${tailscaleBinary()} up --timeout=15s`,
      serveCommand: `${tailscaleBinary()} serve --bg --yes --https=443 ${shellQuote(localUrl)}`,
      disableCommand: `${tailscaleBinary()} serve reset`,
      operatorCommand: `sudo ${tailscaleBinary()} set --operator=$USER`,
      webUiAvailable: Boolean(webRoot || normalizeHttpUrl(webTargetUrl)),
      updatedAt: now(),
      tailscale,
      serve,
    };
  }

  async function enable(): Promise<RemoteAccessToggleResponse> {
    const localUrl = remoteAccessTargetUrl();
    const online = await ensureTailscaleRunning();
    if (!online.tailscale.running) {
      return {
        message: online.tailscale.authUrl
          ? `Sign in to Tailscale to finish setup: ${online.tailscale.authUrl}`
          : online.tailscale.error ?? "Tailscale is not running.",
        status: online,
      };
    }
    const result = await runTailscale(
      ["serve", "--bg", "--yes", "--https=443", localUrl],
      TAILSCALE_MUTATION_TIMEOUT_MS,
    );
    if (result.code !== 0 || result.error) {
      const message = userFacingCommandError(result) ?? "Unable to enable Tailscale Serve.";
      const next = await status();
      return {
        message,
        status: {
          ...next,
          serve: {
            ...next.serve,
            setupUrl: urlFromText(message),
            error: message,
          },
        },
      };
    }
    logger.info("tailscale serve enabled for OpenPond", { target: localUrl });
    return {
      message: "Remote access is on.",
      status: await status(),
    };
  }

  async function ensureTailscaleRunning(): Promise<RemoteAccessStatus> {
    const current = await status();
    if (!current.tailscale.installed || current.tailscale.running) return current;

    await openTailscaleApp();
    const upResult = await runTailscale(["up", "--timeout=15s"], TAILSCALE_MUTATION_TIMEOUT_MS);
    const next = await status();
    if (next.tailscale.running || next.tailscale.authUrl) return next;
    const authUrl = authUrlFromCommand(upResult);
    if (authUrl) {
      return {
        ...next,
        tailscale: {
          ...next.tailscale,
          authUrl,
        },
      };
    }
    if (upResult.code !== 0 || upResult.error) {
      return {
        ...next,
        tailscale: {
          ...next.tailscale,
          error: userFacingCommandError(upResult) ?? next.tailscale.error ?? "Unable to start Tailscale.",
        },
      };
    }
    return next;
  }

  async function disable(): Promise<RemoteAccessToggleResponse> {
    const current = await status();
    if (!current.serve.enabled) {
      return {
        message: "Remote access is already off.",
        status: current,
      };
    }
    const result = await runTailscale(["serve", "reset"], TAILSCALE_MUTATION_TIMEOUT_MS);
    assertCommandOk(result, "Unable to reset Tailscale Serve.");
    logger.info("tailscale serve reset from OpenPond remote access settings");
    return {
      message: "Remote access is off.",
      status: await status(),
    };
  }

  return {
    status,
    enable,
    disable,
  };
}

function normalizeHttpUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function openTailscaleApp(): Promise<void> {
  if (process.platform !== "darwin") return;
  await new Promise<void>((resolve) => {
    execFile("open", ["-g", "-a", "Tailscale"], { timeout: 4000 }, () => resolve());
  });
}
