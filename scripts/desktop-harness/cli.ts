import path from "node:path";
import type { DesktopHarnessRunOptions, DesktopHarnessLaunchMode } from "./types.js";

export function parseDesktopHarnessArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DesktopHarnessRunOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    throw new DesktopHarnessHelpRequested();
  }
  const command = argv[0];
  if (command !== "run") {
    throw new Error(`usage: pnpm exec tsx scripts/desktop-harness.ts run <scenario...> [--isolated|--attach|--packaged|--none] [--json <path>]`);
  }

  const scenarioPaths: string[] = [];
  let grep: string | null = null;
  let launchMode: DesktopHarnessLaunchMode = "isolated";
  let artifactsDir: string | null = null;
  let jsonPath: string | null = null;
  let timeoutMs: number | undefined;
  let keepHome = false;
  let skipBuild = false;
  let frozenRenderer = false;
  let appPath: string | null = null;
  let serverUrl: string | null = env.OPENPOND_APP_CURRENT_SERVER_URL ?? null;
  let token: string | null = env.OPENPOND_APP_CURRENT_SERVER_TOKEN ?? null;
  let tokenFile: string | null = env.OPENPOND_APP_CURRENT_SERVER_TOKEN_FILE ?? null;
  let devtoolsPort: number | null = null;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--isolated") {
      launchMode = "isolated";
      continue;
    }
    if (arg === "--attach") {
      launchMode = "attach";
      continue;
    }
    if (arg === "--packaged") {
      launchMode = "packaged";
      continue;
    }
    if (arg === "--none") {
      launchMode = "none";
      continue;
    }
    if (arg === "--keep-home") {
      keepHome = true;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--frozen-renderer") {
      frozenRenderer = true;
      continue;
    }
    if (arg === "--grep") {
      grep = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--grep=")) {
      grep = arg.slice("--grep=".length);
      continue;
    }
    if (arg === "--artifacts-dir") {
      artifactsDir = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      artifactsDir = arg.slice("--artifacts-dir=".length);
      continue;
    }
    if (arg === "--app") {
      appPath = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--app=")) {
      appPath = arg.slice("--app=".length);
      continue;
    }
    if (arg === "--json") {
      jsonPath = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--json=")) {
      jsonPath = arg.slice("--json=".length);
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }
    if (arg === "--server") {
      serverUrl = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--server=")) {
      serverUrl = arg.slice("--server=".length);
      continue;
    }
    if (arg === "--token") {
      token = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    if (arg === "--token-file") {
      tokenFile = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--token-file=")) {
      tokenFile = arg.slice("--token-file=".length);
      continue;
    }
    if (arg === "--devtools-port") {
      devtoolsPort = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg.startsWith("--devtools-port=")) {
      devtoolsPort = parsePositiveInteger(arg.slice("--devtools-port=".length), "--devtools-port");
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown desktop harness option: ${arg}`);
    scenarioPaths.push(path.normalize(arg));
  }

  if (scenarioPaths.length === 0) throw new Error("At least one scenario path is required.");
  return {
    scenarioPaths,
    grep,
    launchMode,
    artifactsDir,
    jsonPath,
    timeoutMs,
    keepHome,
    skipBuild,
    frozenRenderer,
    appPath,
    serverUrl,
    token,
    tokenFile,
    devtoolsPort,
  };
}

export function desktopHarnessUsage(): string {
  return [
    "usage: pnpm exec tsx scripts/desktop-harness.ts run <scenario...> [options]",
    "",
    "Options:",
    "  --isolated              Launch a fresh dev desktop with temporary app/user-data homes. Default.",
    "  --attach                Attach to an existing server; use --devtools-port for renderer assertions.",
    "  --packaged              Launch an existing packaged desktop app from --app or release/ candidates.",
    "  --none                  Do not connect to desktop/server; intended for runner tests only.",
    "  --app <path>            Packaged app executable or .app bundle for --packaged.",
    "  --server <url>          Existing server URL for --attach.",
    "  --token <token>         Existing server token for --attach.",
    "  --token-file <path>     Existing server token file for --attach.",
    "  --devtools-port <port>  Existing Electron remote-debugging port for renderer assertions.",
    "  --artifacts-dir <path>  Directory for screenshots and reports.",
    "  --json <path>           Write the run report JSON.",
    "  --grep <pattern>        Run scenarios whose names match the regex.",
    "  --timeout-ms <ms>       Scenario timeout.",
    "  --keep-home             Preserve temporary app home after isolated runs.",
    "  --skip-build            Reuse existing server and desktop bundles for an isolated run.",
    "  --frozen-renderer       Build the web UI once and serve it without hot reload.",
  ].join("\n");
}

export class DesktopHarnessHelpRequested extends Error {
  constructor() {
    super(desktopHarnessUsage());
  }
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}
