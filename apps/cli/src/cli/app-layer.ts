import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliUsageError } from "./common";
import { runProcessCommand } from "../process-runner";
import { IS_COMPILED_CLI } from "./build-mode";

type CliOptions = Record<string, string | boolean>;
type AppEntrypoint = { runner: string; args: string[]; cwd: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class OpenPondChildProcessExitError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "OpenPondChildProcessExitError";
  }
}

export async function runOpenPondServerCommand(
  mode: "serve" | "web",
  options: CliOptions,
  rest: string[],
): Promise<void> {
  const server = resolveAppEntrypoint("server");
  const args = [...server.args, mode, ...forwardedOptions(options), ...rest];
  if (mode === "web") {
    args.push(options.noOpen === true || options.noOpen === "true" ? "--print-access-url" : "--open-browser");
  }
  const webRoot = mode === "web" && typeof options.webRoot !== "string" ? packagedWebRoot() : null;
  if (webRoot) args.push("--web-root", webRoot);
  await runChild(server.runner, args, server.cwd);
}

export async function runOpenPondTerminalCommand(options: CliOptions, rest: string[]): Promise<void> {
  validateTerminalForwardingOptions(options);
  const terminal = resolveAppEntrypoint("terminal");
  const server = resolveAppEntrypoint("server");
  const args = [...terminal.args, "chat", ...forwardedOptions(normalizeTerminalPaths(options)), ...rest];
  await runChild(terminal.runner, args, process.cwd(), {
    OPENPOND_SERVER_RUNNER: server.runner,
    OPENPOND_SERVER_ARGS: JSON.stringify(server.args),
    OPENPOND_SERVER_CWD: server.cwd,
  });
}

function findWorkspaceRoot(): string | null {
  if (process.env.OPENPOND_FORCE_EMBEDDED_COMPANIONS === "1") return null;
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
  return null;
}

function resolveAppEntrypoint(app: "server" | "terminal"): AppEntrypoint {
  const workspaceRoot = findWorkspaceRoot();
  if (workspaceRoot) {
    const source = path.join(workspaceRoot, "apps", app, "src", "index.ts");
    if (existsSync(source)) {
      const workspaceRequire = createRequire(path.join(workspaceRoot, "package.json"));
      return {
        runner: process.execPath,
        args: [workspaceRequire.resolve("tsx/cli"), source],
        cwd: workspaceRoot,
      };
    }
    const built = path.join(workspaceRoot, "apps", app, "dist", "index.js");
    if (existsSync(built)) return { runner: process.execPath, args: [built], cwd: workspaceRoot };
  }

  const installedCli = installedCliEntrypoint();
  const embeddedMode = app === "server" ? "__server" : "__terminal";
  if (installedCli) {
    return { runner: process.execPath, args: [installedCli, embeddedMode], cwd: path.dirname(path.dirname(installedCli)) };
  }
  if (isCompiledExecutable()) return { runner: process.execPath, args: [embeddedMode], cwd: process.cwd() };
  throw new Error(`Could not find the installed OpenPond ${app} companion.`);
}

function installedCliEntrypoint(): string | null {
  for (const candidate of [
    path.resolve(__dirname, "../cli.js"),
    path.resolve(__dirname, "../../dist/cli.js"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function packagedWebRoot(): string | null {
  if (IS_COMPILED_CLI) {
    const candidate = path.join(path.dirname(process.execPath), "web");
    return existsSync(path.join(candidate, "index.html")) ? candidate : null;
  }
  const installedCli = installedCliEntrypoint();
  if (!installedCli) return null;
  const candidate = path.join(path.dirname(installedCli), "web");
  return existsSync(path.join(candidate, "index.html")) ? candidate : null;
}

function isCompiledExecutable(): boolean {
  if (IS_COMPILED_CLI) return true;
  const argvEntry = process.argv[1];
  return Boolean(argvEntry && path.resolve(argvEntry) === path.resolve(process.execPath));
}

function forwardedOptions(options: CliOptions): string[] {
  const ignored = new Set(["account", "handle", "baseUrl", "noOpen", "tui"]);
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

function normalizeTerminalPaths(options: CliOptions): CliOptions {
  const callerCwd = process.cwd();
  const next: CliOptions = { ...options };
  if (typeof options.cwd === "string" && options.cwd.trim().length > 0) {
    next.cwd = path.resolve(callerCwd, options.cwd);
  }
  if (typeof options.messageFile === "string" && options.messageFile.trim().length > 0) {
    next.messageFile = path.resolve(callerCwd, options.messageFile);
  }
  return next;
}

function validateTerminalForwardingOptions(options: CliOptions): void {
  if (
    typeof options.approvalPolicy === "string" &&
    !["on-request", "never", "on-failure", "untrusted"].includes(options.approvalPolicy)
  ) {
    throw new CliUsageError("approval-policy must be on-request, never, on-failure, or untrusted");
  }
  if (
    typeof options.sandbox === "string" &&
    !["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)
  ) {
    throw new CliUsageError("sandbox must be read-only, workspace-write, or danger-full-access");
  }
}

async function runChild(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const result = await runProcessCommand(command, args, {
    cwd,
    // Keep embedded companions in the CLI's process group so an outer package
    // runner can stop the complete installed CLI tree with one signal.
    detached: false,
    env,
    inherit: true,
    timeoutMs: 0,
  });
  if (result.code !== 0 || result.signal) {
    const detail = result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`;
    throw new OpenPondChildProcessExitError(`${path.basename(command)} exited with ${detail}`, result.code ?? 1);
  }
}
