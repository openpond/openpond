import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outfile = path.resolve(valueAfter("--outfile") ?? path.join(root, "release-cli", "openpond"));
const sqliteAddon = path.join(root, "node_modules", "sqlite3", "build", "Release", "node_sqlite3.node");
const nodePtyAddon = firstExisting([
  path.join(root, "node_modules", "node-pty", "build", "Release", "pty.node"),
  path.join(root, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "pty.node"),
]);

if (!existsSync(sqliteAddon)) {
  throw new Error(`sqlite3 native addon is missing: ${sqliteAddon}`);
}
if (!nodePtyAddon) {
  throw new Error(`node-pty native addon is missing for ${process.platform}-${process.arch}`);
}

const result = await Bun.build({
  entrypoints: [path.join(root, "apps", "cli", "src", "cli", "main.ts")],
  compile: { outfile },
  define: { __OPENPOND_COMPILED_CLI__: "true" },
  plugins: [{
    name: "openpond-compiled-native-addons",
    setup(build) {
      build.onLoad({ filter: /sqlite3[\\/]lib[\\/]sqlite3-binding\.js$/ }, () => ({
        contents: `module.exports = require(${JSON.stringify(sqliteAddon)});`,
        loader: "js",
      }));
      build.onLoad({ filter: /node-pty[\\/]lib[\\/]utils\.js$/ }, () => ({
        contents: nodePtyUtilsModule(nodePtyAddon),
        loader: "js",
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function nodePtyUtilsModule(addonPath: string): string {
  return `
const path = require("node:path");
exports.assign = function assign(target, ...sources) {
  for (const source of sources) {
    for (const key of Object.keys(source)) target[key] = source[key];
  }
  return target;
};
exports.loadNativeModule = function loadNativeModule(name) {
  if (name !== "pty") throw new Error("Unsupported compiled node-pty addon: " + name);
  return {
    dir: path.join(path.dirname(process.execPath), "runtime", "node-pty"),
    module: require(${JSON.stringify(addonPath)}),
  };
};
`;
}
