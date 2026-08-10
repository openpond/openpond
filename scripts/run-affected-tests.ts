import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const base = args.get("base");
  const head = args.get("head") ?? "HEAD";
  if (!base) throw new Error("affected tests require --base <sha>");

  const changed = await gitLines(["diff", "--name-only", "--diff-filter=ACMRD", base, head]);
  const existing = (await Promise.all(changed.map(async (file) => await exists(file) ? file : null)))
    .filter((file): file is string => file !== null);
  const relatedInputs = existing.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && !file.endsWith(".test.mjs"));
  const nodeTests = existing.filter((file) => file.endsWith(".test.mjs"));

  if (relatedInputs.length > 0) {
    await run(vitest, ["related", ...relatedInputs, "--run", "--passWithNoTests"]);
  } else {
    console.log("[affected-tests] no JavaScript or TypeScript inputs changed");
  }
  if (nodeTests.length > 0) await run(process.execPath, ["--test", ...nodeTests]);
}

function parseArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument list near ${key ?? "end"}`);
    values.set(key.slice(2), value);
  }
  return values;
}

async function gitLines(args: string[]): Promise<string[]> {
  let output = "";
  const child = spawn("git", args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`);
  return output.split(/\r?\n/).filter(Boolean);
}

async function run(command: string, args: string[]): Promise<void> {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit", shell: false });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`${command} failed with ${signal ?? `exit code ${code}`}`);
}

async function exists(relativePath: string): Promise<boolean> {
  return access(path.join(root, relativePath)).then(() => true, () => false);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
