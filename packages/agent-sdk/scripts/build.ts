#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
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

for (const [entrypoint, outfile] of publicEntries) {
  await mkdir(path.dirname(path.join(root, outfile)), { recursive: true });
  await run([
    "bun",
    "build",
    path.join(root, entrypoint),
    "--outfile",
    path.join(root, outfile),
    "--target",
    "bun",
    "--format",
    "esm",
  ]);
}

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
  const withShebang = cli.startsWith("#!/usr/bin/env bun")
    ? cli
    : `#!/usr/bin/env bun\n${cli}`;
  if (withShebang !== cli) await writeFile(cliPath, withShebang, "utf8");
  await chmod(cliPath, 0o755);
}

async function run(command: string[]) {
  const proc = Bun.spawn(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return;
  throw new Error(
    [
      `Command failed: ${command.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join("\n"),
  );
}
