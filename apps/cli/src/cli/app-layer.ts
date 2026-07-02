import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessCommand } from "../process-runner";

type CliOptions = Record<string, string | boolean>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runOpenPondServerCommand(
  mode: "serve" | "web",
  options: CliOptions,
  rest: string[],
): Promise<void> {
  const root = findWorkspaceRoot();
  const server = resolveAppEntrypoint(root, "server");
  const args = [server.entry, mode, ...forwardedOptions(options), ...rest];
  await runChild(server.runner, args, root);
}

export async function runOpenPondTerminalCommand(options: CliOptions, rest: string[]): Promise<void> {
  const root = findWorkspaceRoot();
  const terminal = resolveAppEntrypoint(root, "terminal");
  const args = [terminal.entry, "chat", ...forwardedOptions(options), ...rest];
  await runChild(terminal.runner, args, root);
}

function findWorkspaceRoot(): string {
  const candidates = [
    path.resolve(__dirname, "../../../.."),
    path.resolve(__dirname, "../../.."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "apps", "server")) && existsSync(path.join(candidate, "apps", "terminal"))) {
      return candidate;
    }
  }
  throw new Error("Could not find the OpenPond workspace root for the local app server.");
}

function resolveAppEntrypoint(root: string, app: "server" | "terminal"): { runner: string; entry: string } {
  const source = path.join(root, "apps", app, "src", "index.ts");
  if (existsSync(source)) {
    return { runner: process.env.BUN_BINARY || "bun", entry: source };
  }
  const built = path.join(root, "apps", app, "dist", "index.js");
  if (existsSync(built)) {
    return { runner: process.execPath, entry: built };
  }
  throw new Error(`Could not find the OpenPond ${app} entrypoint.`);
}

function forwardedOptions(options: CliOptions): string[] {
  const ignored = new Set(["account", "handle", "baseUrl", "tui"]);
  const args: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (ignored.has(key)) continue;
    const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    if (value === true || value === "true") {
      args.push(flag);
    } else if (value === false || value === "false") {
      continue;
    } else {
      args.push(flag, value);
    }
  }
  return args;
}

async function runChild(command: string, args: string[], cwd: string): Promise<void> {
  const result = await runProcessCommand(command, args, {
    cwd,
    inherit: true,
    timeoutMs: 0,
  });
  if (result.code && result.code !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.code}`);
  }
}
