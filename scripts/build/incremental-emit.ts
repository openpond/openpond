import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
import { digest } from "./content-cache.ts";

// Caller holds the package build lock until publication completes.
export async function incrementalEmit(
  root: string,
  declarationsOnly = false,
  project = "tsconfig.build.json",
): Promise<string> {
  const cache = path.join(root, "node_modules/.cache/compiler");
  const output = path.join(cache, "emit");
  const receiptFile = path.join(cache, "receipt.json");
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(root, project),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config || config.errors.length) throw new Error("Invalid build TypeScript configuration");
  // Removed/renamed source files need a clean emit: incremental tsc does not
  // delete their old outputs. Content edits can retain compiler state.
  const shape = JSON.stringify({
    files: config.fileNames.sort(),
    options: config.options,
    toolchain: await digest([
      path.join(workspace, "pnpm-lock.yaml"),
      path.join(workspace, "scripts/run-typescript.mjs"),
      path.join(workspace, "scripts/build/incremental-emit.ts"),
    ]),
  });
  const receipt = JSON.stringify({ shape, outputs: await digest([output]) });
  if ((await fs.readFile(receiptFile, "utf8").catch(() => "")) !== receipt)
    await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.rm(receiptFile, { force: true });
  const args = [
    path.join(workspace, "scripts/run-typescript.mjs"),
    "tsgo",
    "--project",
    project,
    "--outDir",
    output,
    "--declarationDir",
    declarationsOnly ? output : path.join(output, "types"),
    "--tsBuildInfoFile",
    path.join(output, ".tsbuildinfo"),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`TypeScript exited with ${code ?? signal}`)),
    );
  });
  await fs.writeFile(receiptFile, JSON.stringify({ shape, outputs: await digest([output]) }));
  return output;
}
