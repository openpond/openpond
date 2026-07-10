#!/usr/bin/env node

import { parseArgs } from "./common/args";
import { parseBooleanOption } from "./common/options";
import { resolveAccountOption, resolveBaseUrlOption } from "./common/urls";
import { getInstalledCliVersion } from "./common/version";
import { runCliCommand } from "./command-registry";

export async function runOpenPondCli(argv = process.argv.slice(2)): Promise<void> {
  if (await runEmbeddedCompanion(argv)) return;
  const { command, options, rest } = parseArgs(argv);
  if (options.version !== undefined && !command) {
    console.log(getInstalledCliVersion());
    return;
  }
  if (options.checkUpdate !== undefined) {
    await (await import("./core-commands")).runCheckUpdate();
    return;
  }
  const selectedAccount = resolveAccountOption(options);
  const selectedBaseUrl = resolveBaseUrlOption(options);
  if (selectedAccount) {
    process.env.OPENPOND_ACCOUNT = selectedAccount;
  }
  if (selectedBaseUrl) {
    process.env.OPENPOND_BASE_URL = selectedBaseUrl;
  }

  if (parseBooleanOption(options.tui)) {
    await (await import("./app-layer")).runOpenPondTerminalCommand(options, rest);
    return;
  }

  if (!command && process.stdin.isTTY && process.stdout.isTTY) {
    await (await import("./app-layer")).runOpenPondTerminalCommand(options, rest);
    return;
  }

  if (!command) {
    (await import("./help")).printHelp();
    return;
  }

  if (await runCliCommand({ command, options, rest })) {
    return;
  }

  (await import("./help")).printHelp();
  process.exit(1);
}

async function runEmbeddedCompanion(argv: string[]): Promise<boolean> {
  if (argv[0] === "__server") {
    process.argv = [process.execPath, "openpond-server", ...argv.slice(1)];
    const [{ createOpenPondServer }, { runOpenPondServerCli }] = await Promise.all([
      import("@openpond/local-server"),
      import("@openpond/local-server/cli"),
    ]);
    await runOpenPondServerCli(createOpenPondServer);
    return true;
  }
  if (argv[0] === "__terminal") {
    await (await import("@openpond/terminal")).runOpenPondTerminalCli(argv.slice(1));
    return true;
  }
  return false;
}

void runOpenPondCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  const exitCode = typeof (error as { exitCode?: unknown }).exitCode === "number"
    ? (error as { exitCode: number }).exitCode
    : 1;
  process.exit(exitCode);
});
