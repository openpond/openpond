import { getBundledRuntimeVersion, openUrlWithSystemBrowser } from "@openpond/runtime";
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
  openBrowser: boolean;
  printAccessUrl: boolean;
  help: boolean;
};
type BrowserHandoff = typeof openUrlWithSystemBrowser;

export type WebLaunchMessages = {
  stdout: string[];
  stderr: string[];
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
  let openBrowser = false;
  let printAccessUrl = false;
  let index = 0;

  const command = args[0];
  if (command && !command.startsWith("-")) {
    if (command === "serve" || command === "server") mode = "serve";
    else if (command === "web") mode = "web";
    else if (command === "help") {
      return { mode, host, port, webRoot, openBrowser, printAccessUrl, help: true };
    }
    else throw new Error(`Unknown command: ${command}`);
    index = 1;
  }

  for (let i = index; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      return { mode, host, port, webRoot, openBrowser, printAccessUrl, help: true };
    }
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
    } else if (arg === "--open-browser") {
      openBrowser = true;
    } else if (arg === "--print-access-url") {
      printAccessUrl = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (openBrowser && printAccessUrl) {
    throw new Error("--open-browser and --print-access-url cannot be used together.");
  }
  if (mode !== "web" && (openBrowser || printAccessUrl)) {
    throw new Error("Browser options are only available in web mode.");
  }
  return { mode, host, port, webRoot, openBrowser, printAccessUrl, help: false };
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

export async function resolveWebLaunchMessages(
  input: {
    baseUrl: string;
    openBrowser: boolean;
    printAccessUrl: boolean;
    token: string;
  },
  handOffToBrowser: BrowserHandoff = openUrlWithSystemBrowser,
): Promise<WebLaunchMessages> {
  const accessUrl = tokenizedWebUrl(input.baseUrl, input.token);
  if (input.printAccessUrl) {
    return { stdout: [`OpenPond access URL: ${accessUrl}`], stderr: [] };
  }
  if (!input.openBrowser) {
    return { stdout: [`OpenPond web UI: ${input.baseUrl}`], stderr: [] };
  }

  const handoff = await handOffToBrowser(accessUrl);
  if (handoff.opened) {
    return { stdout: [`Opened OpenPond in your browser: ${input.baseUrl}`], stderr: [] };
  }
  return {
    stdout: [`OpenPond access URL: ${accessUrl}`],
    stderr: [`Could not open the system browser: ${handoff.error}`],
  };
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
  --open-browser         Open the authenticated web URL in the system browser
  --print-access-url     Print the authenticated URL instead of opening it
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
  const webBaseUrl = args.mode === "web" ? browserBaseUrl(instance) : null;
  console.log(
    `OPENPOND_APP_SERVER_READY ${JSON.stringify({
      mode: args.mode,
      url: instance.url,
      webUrl: null,
      webRoot,
      tokenFile: instance.tokenFile,
      storePath: instance.storePath,
      runtime: getBundledRuntimeVersion(),
    })}`
  );
  if (webBaseUrl) {
    const messages = await resolveWebLaunchMessages({
      baseUrl: webBaseUrl,
      openBrowser: args.openBrowser,
      printAccessUrl: args.printAccessUrl,
      token: instance.token,
    });
    for (const message of messages.stderr) console.error(message);
    for (const message of messages.stdout) console.log(message);
  } else {
    console.log(`OpenPond API server: ${instance.url}`);
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    // Keep the CLI entrypoint alive when the server is launched outside Electron.
  });
}
