import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliUsageError } from "./common";
import { parseBooleanOption } from "./common/options";
import { runCommand } from "./common/shell";

const installer = "skills@1.7.4";
const agents = new Set(["codex", "claude-code", "opencode", "cursor"]);

/** Explicit opt-in delegation to the standard installer; npm install itself
 * never changes another coding agent's catalog or connection settings. */
export async function runSkillsCommand(options: Record<string, string | boolean>, rest: string[]) {
  const action = rest[0] ?? "list";
  if (rest.length > 1 || !["install", "list"].includes(action))
    throw new CliUsageError(
      "Use openpond skills <install|list> --agent <codex|claude-code|opencode|cursor> [--global].",
    );
  const agent = options.agent;
  if (typeof agent !== "string" || !agents.has(agent))
    throw new CliUsageError(
      "Choose one supported --agent: codex, claude-code, opencode or cursor.",
    );
  const global = parseBooleanOption(options.global);
  const cwd = typeof options.cwd === "string" ? path.resolve(options.cwd) : process.cwd();
  let identity: { package: string; version: string; sha256: string } | undefined;
  let args: string[];
  if (action === "install") {
    const pack = await customerPack();
    identity = pack.identity;
    args = ["--yes", installer, "add", pack.source, "--agent", agent, "--skill", ...pack.names];
    if (parseBooleanOption(options.yes)) args.push("--yes");
    if (parseBooleanOption(options.copy)) args.push("--copy");
  } else args = ["--yes", installer, "list", "--agent", agent];
  if (global) args.push("--global");
  if (parseBooleanOption(options.json)) args.push("--json");
  if (parseBooleanOption(options.dryRun)) {
    console.log(
      JSON.stringify(
        {
          action,
          agent,
          scope: global ? "global" : "project",
          cwd,
          installer,
          package: identity,
          executable: "npx",
          arguments: args,
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await runCommand(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd,
    inherit: true,
  });
  if (result.code !== 0) throw new Error(`Skills installer exited with code ${result.code}.`);
  // Installer success proves installation, not that a running client has refreshed.
  if (action === "install")
    console.error(
      "Open a new agent session and confirm the skills are discoverable. Use openpond skills list with the same agent and scope to inspect installed records.",
    );
}

async function customerPack() {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 7; depth++) {
    let pkg: { name?: string; version?: string } | undefined;
    try {
      pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    } catch {
      /* Inspect parent package. */
    }
    if (pkg?.name === "openpond") {
      const source = path.join(directory, "dist", "skills");
      const raw = await readFile(path.join(source, "manifest.json"), "utf8").catch(() => {
        throw new CliUsageError(
          "This CLI has no packaged customer skills. Update OpenPond, or run skills:package when developing from source.",
        );
      });
      const manifest = JSON.parse(raw) as {
        package: string;
        version: string;
        skills: { name: string }[];
        sourceFiles: { path: string; sha256: string }[];
      };
      if (
        manifest.package !== "openpond" ||
        manifest.version !== pkg.version ||
        !Array.isArray(manifest.skills) ||
        !Array.isArray(manifest.sourceFiles)
      )
        throw new Error("Invalid customer skill pack identity.");
      const names = manifest.skills.map((skill) => skill.name);
      if (
        names.length !== 5 ||
        new Set(names).size !== 5 ||
        names.some(
          (name) => !/^openpond-[a-z-]+$/.test(name) || name === "openpond-desktop-harness",
        )
      )
        throw new Error("Invalid customer skill selection.");
      for (const file of manifest.sourceFiles) {
        if (
          path.isAbsolute(file.path) ||
          file.path.split(/[\\/]/).includes("..") ||
          !names.includes(file.path.split("/")[0]!)
        )
          throw new Error("Unsafe customer skill path.");
        const resolved = await realpath(path.join(source, file.path));
        if (!resolved.startsWith(`${await realpath(source)}${path.sep}`))
          throw new Error("Customer skill escapes its packaged source.");
        if (hash(await readFile(resolved)) !== file.sha256)
          throw new Error(`Customer skill pack failed integrity verification: ${file.path}`);
      }
      return {
        source,
        names,
        identity: { package: "openpond", version: manifest.version, sha256: hash(raw) },
      };
    }
    directory = path.dirname(directory);
  }
  throw new CliUsageError("Cannot locate the installed OpenPond customer skill pack.");
}
function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
