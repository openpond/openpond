import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
export async function bundledChatCliEnvironment(): Promise<NodeJS.ProcessEnv> {
  // Source development uses the official CLI source, including newly added
  // commands, without requiring a package build. Packaged JS uses only dist.
  if (import.meta.url.endsWith(".ts")) {
    const source = path.resolve(directory, "../../../cli/src/cli/source-entry.mjs");
    if (await access(source).then(() => true, () => false)) {
      return { OPENPOND_CLI_NODE: process.execPath, OPENPOND_CLI_ENTRY: source };
    }
  }
  const candidates = [
    path.resolve(directory,"../../../cli/dist/cli.js"),
    path.resolve(directory,"cli.js"),
    path.resolve(directory,"../cli.js"),
    path.resolve(directory,"../cli/cli.js"),
    path.resolve(process.cwd(),"apps/cli/dist/cli.js"),
  ];
  for (const entry of candidates) {
    if (await access(entry).then(()=>true,()=>false)) return { OPENPOND_CLI_NODE:process.execPath,OPENPOND_CLI_ENTRY:entry };
  }
  throw new Error("The bundled OpenPond CLI is unavailable. Repair the app installation before using CLI workflows.");
}
