#!/usr/bin/env node

import { parseArgs } from "./common/args";
import { resolveAccountOption, resolveBaseUrlOption } from "./common/urls";
import { getInstalledCliVersion } from "./common/version";
import { runCliCommand } from "./command-registry";
import { resolveCliTopLevelAction } from "./top-level-action";

export async function runOpenPondCli(argv = process.argv.slice(2)): Promise<void> {
  if (await runEmbeddedCompanion(argv)) return;
  const { command, options, rest } = parseArgs(argv);
  if (typeof options.home === "string") process.env.OPENPOND_HOME = (await import("@openpond/persistence")).resolveOpenPondHome({ home: options.home });
  const action = resolveCliTopLevelAction({ command, options });
  if (action === "version") {
    console.log(getInstalledCliVersion());
    return;
  }
  if (action === "check-update") {
    await (await import("./core-commands")).runCheckUpdate();
    return;
  }
  if (action === "help") {
    (await import("./help")).printHelp();
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

  if (action === "tui") {
    await (await import("./app-layer")).runOpenPondTerminalCommand(options, rest);
    return;
  }

  if (action === "ui") {
    await (await import("./app-layer")).runOpenPondServerCommand("web", options, rest);
    return;
  }

  if (await runCliCommand({ command, options, rest })) {
    return;
  }

  (await import("./help")).printHelp();
  process.exit(1);
}

async function runEmbeddedCompanion(argv: string[]): Promise<boolean> {
  if (argv[0] === "__app-server") {
    process.argv = [process.execPath, "openpond-app-server", ...argv.slice(1)];
    const [{ createOpenPondAppServer }, { runOpenPondAppServerCli }] = await Promise.all([
      import("@openpond/local-server/app-server-runtime"),
      import("@openpond/local-server/cli"),
    ]);
    await runOpenPondAppServerCli(createOpenPondAppServer);
    return true;
  }
  if (argv[0] === "__server") {
    process.argv = [process.execPath, "openpond-server", ...argv.slice(1)];
    const [{ createOpenPondServer }, { runOpenPondServerCli }] = await Promise.all([
      import("@openpond/local-server"),
      import("@openpond/local-server/cli"),
    ]);
    const { createOpenPondAppServer } = await import("@openpond/local-server/app-server-runtime");
    await runOpenPondServerCli({ createOpenPondServer, createOpenPondAppServer });
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
  const issue = (error as { issue?: unknown }).issue;
  if (process.argv.includes("--json") && !(error instanceof Error && error.name === "OpenPondChildProcessExitError")) console.log(JSON.stringify({ error: issue ?? { code: "CLI_ERROR", message } }));
  else if (issue && typeof issue === "object") {
    const detail = issue as { code: string; path: string; message: string; action: string };
    console.error(`${detail.code}: ${detail.message}\n${detail.path}\n${detail.action}`);
  } else console.error(message);
  const exitCode = typeof (error as { exitCode?: unknown }).exitCode === "number"
    ? (error as { exitCode: number }).exitCode
    : 1;
  process.exit(exitCode);
});
