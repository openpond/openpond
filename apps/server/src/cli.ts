import { getBundledRuntimeVersion } from "@openpond/runtime";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import type { OpenPondServerInstance, OpenPondServerOptions } from "./types.js";
import { parseListen } from "./utils.js";

type CreateServer = (options: OpenPondServerOptions) => Promise<OpenPondServerInstance>;
type CliMode = "serve" | "web";
type ParsedCliArgs = {
  mode: CliMode;
  host: string;
  port: number;
  webRoot: string | null;
  help: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePort(value: string, flag: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error(`${flag} must be a port from 0 to 65535.`);
  return port;
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  let mode: CliMode = "serve";
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let webRoot: string | null = null;
  let index = 0;

  const command = args[0];
  if (command && !command.startsWith("-")) {
    if (command === "serve" || command === "server") mode = "serve";
    else if (command === "web") mode = "web";
    else if (command === "help") return { mode, host, port, webRoot, help: true };
    else throw new Error(`Unknown command: ${command}`);
    index = 1;
  }

  for (let i = index; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { mode, host, port, webRoot, help: true };
    if (arg === "--listen") {
      const listen = parseListen(requireValue(args, i, arg));
      host = listen.host;
      port = parsePort(String(listen.port), arg);
      i += 1;
    } else if (arg === "--hostname" || arg === "--host") {
      host = requireValue(args, i, arg);
      i += 1;
    } else if (arg === "--port") {
      port = parsePort(requireValue(args, i, arg), arg);
      i += 1;
    } else if (arg === "--web-root") {
      webRoot = path.resolve(requireValue(args, i, arg));
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { mode, host, port, webRoot, help: false };
}

function defaultWebRootCandidates(): string[] {
  return [
    process.env.OPENPOND_WEB_ROOT,
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(__dirname, "../../web/dist"),
    path.resolve(process.cwd(), "web"),
    path.resolve(__dirname, "../web"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function resolveWebRoot(explicitWebRoot: string | null): string | null {
  const candidates = explicitWebRoot ? [explicitWebRoot] : defaultWebRootCandidates();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, "index.html"))) return resolved;
  }
  return null;
}

function formatHostForUrl(host: string): string {
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return browserHost.includes(":") && !browserHost.startsWith("[") ? `[${browserHost}]` : browserHost;
}

function browserBaseUrl(instance: OpenPondServerInstance): string {
  return `http://${formatHostForUrl(instance.status.host)}:${instance.status.port}`;
}

function tokenizedWebUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();
  params.set("openpondServerUrl", baseUrl);
  params.set("openpondToken", token);
  url.hash = params.toString();
  return url.toString();
}

function printHelp(): void {
  console.log(`Usage:
  openpond-app-server serve [--hostname HOST] [--port PORT]
  openpond-app-server web [--hostname HOST] [--port PORT] [--web-root DIR]

Options:
  --listen HOST:PORT     Set host and port together
  --hostname HOST        Bind host (default ${DEFAULT_HOST})
  --port PORT            Bind port, or 0 for any free port (default ${DEFAULT_PORT})
  --web-root DIR         Directory containing the built web UI for web mode
`);
}

export async function runOpenPondServerCli(createOpenPondServer: CreateServer): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const webRoot = args.mode === "web" ? resolveWebRoot(args.webRoot) : null;
  if (args.mode === "web" && !webRoot) {
    throw new Error("Could not find a built OpenPond web UI. Run `pnpm build:web` or pass --web-root.");
  }

  const instance = await createOpenPondServer({ host: args.host, port: args.port, webRoot });
  const webUrl = args.mode === "web" ? tokenizedWebUrl(browserBaseUrl(instance), instance.token) : null;
  console.log(
    `OPENPOND_APP_SERVER_READY ${JSON.stringify({
      mode: args.mode,
      url: instance.url,
      webUrl,
      webRoot,
      tokenFile: instance.tokenFile,
      storePath: instance.storePath,
      runtime: getBundledRuntimeVersion(),
    })}`
  );
  if (webUrl) {
    console.log(`OpenPond web UI: ${webUrl}`);
    console.log(`Tailscale Serve URL token: #openpondToken=${encodeURIComponent(instance.token)}`);
  } else {
    console.log(`OpenPond API server: ${instance.url}`);
  }
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    // Keep the CLI entrypoint alive when the server is launched outside Electron.
  });
}
