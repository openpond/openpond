import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
};
const dependencies = Object.keys(manifest.dependencies ?? {});
if (dependencies.sort().join(",") !== "@jitl/quickjs-singlefile-cjs-release-sync,@sqlite.org/sqlite-wasm,ajv,quickjs-emscripten-core,zod") {
  throw new Error(
    `@openpond/evals runtime dependencies must contain only the portable schema, JavaScript and SQLite WASM runtimes; found ${dependencies.join(", ") || "none"}.`,
  );
}
const peers = Object.keys(manifest.peerDependencies ?? {});
if (peers.join(",") !== "@openpond/harness") {
  throw new Error(
    `@openpond/evals must peer only on @openpond/harness; found ${peers.join(", ") || "none"}.`,
  );
}
for (const legacySubpath of ["./harness-improvements", "./harness-workspaces"]) {
  if (legacySubpath in (manifest.exports ?? {})) {
    throw new Error(`@openpond/evals must not re-export Harness API ${legacySubpath}.`);
  }
}
const rootIndex = await readFile(path.join(root, "src/index.ts"), "utf8");
if (/export\s+\*\s+from\s+["']@openpond\/harness/.test(rootIndex)) {
  throw new Error("@openpond/evals root must not re-export @openpond/harness.");
}

const forbidden = /(?:@openpond\/(?!harness(?:["'/]|$))|\belectron\b|next\/|better-sqlite|connected-app|provider sdk)/i;
for (const file of await sourceFiles(path.join(root, "src"))) {
  const source = await readFile(file, "utf8");
  // The explicit native-conversations subpath owns local Node SQLite histories;
  // the portable evaluation APIs must retain their WASM database boundary.
  const nativeHistory = path.relative(root, file).startsWith(`src${path.sep}native-conversations${path.sep}`);
  if (forbidden.test(source) || (!nativeHistory && /node:sqlite/i.test(source))) {
    throw new Error(
      `Application-only dependency marker found in ${path.relative(root, file)}.`,
    );
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name);
    if ((await stat(target)).isDirectory()) {
      output.push(...await sourceFiles(target));
    } else if (target.endsWith(".ts")) {
      output.push(target);
    }
  }
  return output;
}
