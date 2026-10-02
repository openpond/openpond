import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { contentHash } from "@openpond/harness";
import {
  type ExternalAgentSource,
  type NativeSource,
  NATIVE_SOURCE_NAMES,
} from "./contracts.js";

/** Discovery returns locations/capabilities only. Transcript reads require a selected source. */
export async function discoverSources(input: {
  machineId: string;
  home?: string;
  locations?: Partial<Record<ExternalAgentSource, string>>;
  environment?: NodeJS.ProcessEnv;
}): Promise<NativeSource[]> {
  const home = input.home ?? homedir(),
    env = input.environment ?? process.env;
  const defaults: Record<ExternalAgentSource, string> = {
    codex: env.CODEX_HOME || join(home, ".codex"),
    claude_code: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    hermes: env.HERMES_HOME || join(home, ".hermes"),
    openclaw: env.OPENCLAW_STATE_DIR || join(home, ".openclaw"),
    opencode: join(env.XDG_DATA_HOME || join(home, ".local/share"), "opencode"),
    grok_build: env.GROK_HOME || join(home, ".grok"),
    pi: env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
    oh_my_pi: env.OMP_CONFIG_DIR || join(home, ".omp/agent"),
  };
  const result: NativeSource[] = [];
  for (const source of Object.keys(
    NATIVE_SOURCE_NAMES,
  ) as ExternalAgentSource[]) {
    let root = resolve(input.locations?.[source] || defaults[source]),
      available = false,
      file = false;
    try {
      root = await realpath(root);
      const info = await stat(root);
      file = info.isFile();
      available = info.isDirectory() || file;
    } catch {
      /* Absent or unreadable source is shown explicitly. */
    }
    result.push({
      source,
      root,
      machineId: input.machineId,
      instanceId: `native-${contentHash([input.machineId, source, root]).slice(0, 40)}`,
      acquisition:
        file && !root.endsWith(".db")
          ? "files"
          : source === "hermes" || source === "opencode"
            ? "sqlite"
            : source === "openclaw"
              ? "bundle"
              : "files",
      available,
      capabilities: {
        history: available,
        live: available,
        nativeResume: false,
      },
      ...(!available
        ? {
            reason:
              "Source location is missing or unreadable. Select a custom location.",
          }
        : {}),
    });
  }
  return result;
}
