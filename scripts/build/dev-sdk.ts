import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// SDK prebuilds and their workspace source dependencies. Application code does
// not invalidate this cache; tsc -b handles the app's incremental compilation.
const packages = ["sdk", "cloud", "actions", "harness", "evals", "persistence", "connected-apps"];

async function digest(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  async function visit(file: string): Promise<void> {
    hash.update(file).update("\0");
    let stat;
    try { stat = await fs.stat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing\0");
      return;
    }
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    } else {
      const bytes = await fs.readFile(file);
      hash.update(`${bytes.length}\0`).update(bytes);
    }
  }
  for (const file of paths) await visit(file);
  return hash.digest("hex");
}

export async function ensureDevBuild(options: {
  inputs: string[];
  outputs: string[];
  cacheFile: string;
  build: () => void | Promise<void>;
}): Promise<"built" | "cached"> {
  const inputs = await digest(options.inputs);
  const outputs = await digest(options.outputs);
  const receipt = JSON.stringify({ inputs, outputs, node: process.version });
  if (await fs.readFile(options.cacheFile, "utf8").catch(() => "") === receipt) return "cached";

  // A failed or interrupted build must never leave a valid receipt behind.
  await fs.rm(options.cacheFile, { force: true });
  await options.build();
  if (await digest(options.inputs) !== inputs) return "built";
  await fs.mkdir(path.dirname(options.cacheFile), { recursive: true });
  await fs.writeFile(options.cacheFile, JSON.stringify({ inputs, outputs: await digest(options.outputs), node: process.version }));
  return "built";
}

async function main(): Promise<void> {
  const inputs = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "scripts/build/dev-sdk.ts"];
  for (const name of packages) {
    const directory = `packages/${name}`;
    inputs.push(`${directory}/src`, `${directory}/scripts`);
    for (const file of (await fs.readdir(path.join(root, directory))).sort()) {
      if (file === "package.json" || /^tsconfig.*\.json$/.test(file)) inputs.push(`${directory}/${file}`);
    }
  }
  const result = await ensureDevBuild({
    inputs: inputs.map(file => path.join(root, file)),
    outputs: packages.map(name => path.join(root, "packages", name, "dist")),
    cacheFile: path.join(root, "node_modules/.cache/openpond-dev-sdk.json"),
    build() {
      const child = spawnSync(process.env.PNPM_BINARY || (process.platform === "win32" ? "pnpm.cmd" : "pnpm"), ["run", "build:sdk"], { cwd: root, stdio: "inherit" });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`SDK build failed (${child.status ?? child.signal})`);
    },
  });
  console.log(result === "cached" ? "Reusing unchanged SDK builds" : "SDK builds refreshed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
