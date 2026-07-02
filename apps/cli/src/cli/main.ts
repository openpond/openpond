#!/usr/bin/env node

import {
  getInstalledCliVersion,
  parseArgs,
  parseBooleanOption,
  resolveAccountOption,
  resolveBaseUrlOption,
} from "./common";
import { printHelp } from "./help";
import { runOpenPondTerminalCommand } from "./app-layer";
import { runCheckUpdate } from "./core-commands";
import { runCliCommand } from "./command-registry";

export async function runOpenPondCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, options, rest } = parseArgs(argv);
  const selectedAccount = resolveAccountOption(options);
  const selectedBaseUrl = resolveBaseUrlOption(options);
  if (selectedAccount) {
    process.env.OPENPOND_ACCOUNT = selectedAccount;
  }
  if (
    !selectedAccount &&
    typeof options.handle === "string" &&
    options.handle.trim().length > 0
  ) {
    process.env.OPENPOND_ACCOUNT = options.handle.trim();
  }
  if (selectedBaseUrl) {
    process.env.OPENPOND_BASE_URL = selectedBaseUrl;
  }

  if (parseBooleanOption(options.tui)) {
    await runOpenPondTerminalCommand(options, rest);
    return;
  }

  if (options.checkUpdate !== undefined) {
    await runCheckUpdate();
    return;
  }

  if (options.version !== undefined && !command) {
    console.log(getInstalledCliVersion());
    return;
  }

  if (!command && process.stdin.isTTY && process.stdout.isTTY) {
    await runOpenPondTerminalCommand(options, rest);
    return;
  }

  if (!command) {
    printHelp();
    return;
  }

  if (await runCliCommand({ command, options, rest })) {
    return;
  }

  printHelp();
  process.exit(1);
}

void runOpenPondCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
