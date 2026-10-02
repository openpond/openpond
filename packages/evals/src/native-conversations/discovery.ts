import { homedir } from "node:os";
import { realpath, stat, readdir, readFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
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
  // Only documented non-secret source-location settings are read, and never emitted.
  const piHome = defaults.pi;
  let piRelativeSetting = false;
  if (env.PI_CODING_AGENT_SESSION_DIR)
    defaults.pi = resolve(env.PI_CODING_AGENT_SESSION_DIR);
  else if (!input.locations?.pi) {
    try {
      const file = join(piHome, "settings.json");
      if ((await stat(file)).size <= 1024 * 1024) {
        const setting = JSON.parse(await readFile(file, "utf8")) as {
          sessionDir?: unknown;
        };
        if (
          typeof setting.sessionDir === "string" &&
          setting.sessionDir.trim()
        ) {
          if (isAbsolute(setting.sessionDir)) defaults.pi = setting.sessionDir;
          else piRelativeSetting = true;
        }
      }
    } catch {
      /* Missing/invalid settings do not authorize broader filesystem discovery. */
    }
  }
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
    if (source === "openclaw" && available && !file) {
      const agentsRoot = join(root, "agents");
      const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(
        () => [],
      );
      const databases: string[] = [];
      for (const agent of agents.slice(0, 100)) {
        if (!agent.isDirectory() || agent.isSymbolicLink()) continue;
        const database = join(
          agentsRoot,
          agent.name,
          "agent",
          "openclaw-agent.sqlite",
        );
        if (
          await stat(database)
            .then((info) => info.isFile())
            .catch(() => false)
        )
          databases.push(await realpath(database));
      }
      if (databases.length) {
        for (const database of databases)
          result.push({
            source,
            root: database,
            machineId: input.machineId,
            instanceId: `native-${contentHash([input.machineId, source, database]).slice(0, 40)}`,
            acquisition: "sqlite",
            available: true,
            capabilities: { history: true, live: true, nativeResume: false },
          });
        continue;
      }
    }
    if (source === "pi" && piRelativeSetting && !input.locations?.pi) {
      result.push({
        source,
        root,
        machineId: input.machineId,
        instanceId: `native-${contentHash([input.machineId, source, root]).slice(0, 40)}`,
        acquisition: "files",
        available: false,
        capabilities: { history: false, live: false, nativeResume: false },
        reason:
          "Pi config uses a working-directory-relative sessionDir. Select its resolved directory with --source-path.",
      });
      continue;
    }
    result.push({
      source,
      root,
      machineId: input.machineId,
      instanceId: `native-${contentHash([input.machineId, source, root]).slice(0, 40)}`,
      acquisition:
        file && !/\.(?:db|sqlite)$/u.test(root)
          ? "files"
          : source === "hermes" ||
              source === "opencode" ||
              (source === "openclaw" && file)
            ? "sqlite"
            : source === "openclaw"
              ? "bundle"
              : "files",
      available,
      capabilities: {
        history: available,
        live: available && (source !== "openclaw" || file),
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
