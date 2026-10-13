import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureDevBuild } from "./content-cache.ts";
import { buildProject } from "./project.ts";
import { withBuildLock } from "./build-lock.ts";
export { ensureDevBuild } from "./content-cache.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// SDK prebuilds and their workspace source dependencies. Application code does
// not invalidate this cache; tsc -b handles the app's incremental compilation.
const packages = ["harness", "connected-apps", "persistence", "cloud", "actions", "evals", "sdk"];
const dependencies: Record<string, string[]> = {
  persistence: ["harness"],
  cloud: ["connected-apps", "persistence"],
  evals: ["harness"],
  sdk: ["cloud", "actions", "harness", "evals", "persistence", "connected-apps"],
};

async function main(): Promise<void> {
  await withBuildLock(path.join(root, "node_modules/.cache/dev-sdk.lock"), async () => {
    for (const name of packages) {
      const directory = `packages/${name}`;
      const inputs = [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
        "scripts/build",
        "scripts/run-typescript.mjs",
        `${directory}/src`,
        `${directory}/scripts`,
      ];
      for (const file of (await fs.readdir(path.join(root, directory))).sort()) {
        if (file === "package.json" || /^tsconfig.*\.json$/.test(file))
          inputs.push(`${directory}/${file}`);
      }
      for (const dependency of dependencies[name] ?? [])
        inputs.push(`packages/${dependency}/src`, `packages/${dependency}/dist`);
      const result = await ensureDevBuild({
        inputs: inputs.map((file) => path.join(root, file)),
        outputs: [path.join(root, directory, "dist")],
        cacheFile: path.join(root, `node_modules/.cache/openpond-dev-${name}.json`),
        async build() {
          if (["connected-apps", "persistence", "cloud", "actions"].includes(name)) {
            await buildProject(path.join(root, directory));
            return;
          }
          // Dependencies above are already prepared; avoid SDK's duplicate prebuilds.
          const args = name === "sdk" ? ["exec", "tsx", "scripts/build.ts"] : ["run", "build"];
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.env.PNPM_BINARY || (process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
              args,
              { cwd: path.join(root, directory), stdio: "inherit" },
            );
            child.once("error", reject);
            child.once("close", (code, signal) =>
              code === 0
                ? resolve()
                : reject(new Error(`${name} build failed (${code ?? signal})`)),
            );
          });
        },
      });
      console.log(`${name}: ${result}`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
