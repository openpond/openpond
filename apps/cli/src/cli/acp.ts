import path from "node:path";
import { resolveOpenPondHome } from "@openpond/persistence";
import { getInstalledCliVersion } from "./common/version";

export async function runAcpCommand(options: Record<string, string | boolean>, rest: string[]): Promise<void> {
  if (rest.length || options.json) throw new Error("openpond acp uses ACP JSON-RPC on stdout; --json and positional arguments are not supported.");
  // The desktop and ACP process cannot both own one SQLite home. A separate default
  // home also prevents unrelated desktop sessions from entering editor discovery.
  const home = typeof options.home === "string" ? resolveOpenPondHome({ home: options.home }) : path.join(resolveOpenPondHome(), "acp-agent");
  process.env.OPENPOND_HOME = home;
  if (options.login) {
    await (await import("./core-commands")).runLogin(options);
    const { AcpAccount } = await import("@openpond/local-server/acp-agent");
    await new AcpAccount(home).models();
    return;
  }
  await (await import("@openpond/local-server/acp-agent")).runOpenPondAcpAgent({ home, version: getInstalledCliVersion(), model: typeof options.model === "string" ? options.model : undefined });
}
