#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const publicEntries = [
  ["src/index.ts", "dist/index.js"],
  ["src/cli.ts", "dist/cli.js"],
  ["src/channels/index.ts", "dist/channels/index.js"],
  ["src/editable/index.ts", "dist/editable/index.js"],
  ["src/eval/index.ts", "dist/eval/index.js"],
  ["src/instructions/index.ts", "dist/instructions/index.js"],
  ["src/integrations/index.ts", "dist/integrations/index.js"],
  ["src/inspect/index.ts", "dist/inspect/index.js"],
  ["src/manifest/index.ts", "dist/manifest/index.js"],
  ["src/primitives/index.ts", "dist/primitives/index.js"],
  ["src/runtime/index.ts", "dist/runtime/index.js"],
  ["src/schemas/index.ts", "dist/schemas/index.js"],
  ["src/schedules/index.ts", "dist/schedules/index.js"],
  ["src/skills/index.ts", "dist/skills/index.js"],
  ["src/tracing/index.ts", "dist/tracing/index.js"],
  ["src/validator/index.ts", "dist/validator/index.js"],
  ["src/volumes/index.ts", "dist/volumes/index.js"],
  ["src/workflow/index.ts", "dist/workflow/index.js"],
] as const;

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: Object.fromEntries(
    publicEntries.map(([entrypoint, outfile]) => [
      outfile.replace(/^dist\//, "").replace(/\.js$/, ""),
      path.join(root, entrypoint),
    ]),
  ),
  outdir: dist,
  bundle: true,
  external: ["tsx"],
  platform: "node",
  target: "node24.18",
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: 'import { createRequire as __openpondCreateRequire } from "node:module"; var require = __openpondCreateRequire(import.meta.url);',
  },
});

await run([resolveTscBin(), "--project", "tsconfig.build.json"]);
await ensureExecutableCli();

function resolveTscBin(): string {
  const candidates = [
    path.join(root, "node_modules/.bin/tsc"),
    path.resolve(root, "..", "..", "node_modules/.bin/tsc"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "tsc";
}

async function ensureExecutableCli() {
  const cliPath = path.join(dist, "cli.js");
  const cli = await readFile(cliPath, "utf8");
  const withShebang = cli.startsWith("#!/usr/bin/env node")
    ? cli
    : `#!/usr/bin/env node\n${cli}`;
  if (withShebang !== cli) await writeFile(cliPath, withShebang, "utf8");
  await chmod(cliPath, 0o755);
}

async function run(command: string[]) {
  const { stdout, stderr, exitCode } = await runProcess(command, root);
  if (exitCode === 0) return;
  throw new Error(
    [
      `Command failed: ${command.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join("\n"),
  );
}

function runProcess(
  command: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ stdout, stderr, exitCode: code ?? (signal ? 1 : 0) });
    });
  });
}
