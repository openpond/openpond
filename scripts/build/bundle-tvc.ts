import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { fromRoot } from "./shared-esbuild.js";

const { values } = parseArgs({ options: { profile: { type: "boolean", default: false } } });
const out = fromRoot("dist", values.profile ? "turnkey-agent-profile" : "turnkey-agent");
const skillsRoot = fromRoot("apps", "cli", "skills");
const assets: Record<string, string> = {};
async function collect(directory: string): Promise<void> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.isFile()) assets[`skills/${path.relative(skillsRoot, file).split(path.sep).join("/")}`] = (await readFile(file)).toString("base64");
    else throw new Error(`Unsupported packaged asset: ${file}`);
  }
}
await collect(skillsRoot);
const packageJson = JSON.parse(await readFile(fromRoot("package.json"), "utf8")) as { version: string };
assets["package.json"] = Buffer.from(JSON.stringify({ name: "openpond-tvc", version: packageJson.version })).toString("base64");
await mkdir(out, { recursive: true });

// The image is a transport for ONE extracted ELF, not a mounted root filesystem.
// Embed assets in the JS payload so ordinary Node and the packaged executable use identical assets.
const bootstrap = `
const __tvcFs = require("node:fs");
const __tvcPath = require("node:path");
const __tvcAssetRoot = __tvcFs.mkdtempSync(__tvcPath.join(require("node:os").tmpdir(), "openpond-tvc-assets-"));
for (const [name, bytes] of Object.entries(${JSON.stringify(assets)})) {
  const target = __tvcPath.join(__tvcAssetRoot, name);
  __tvcFs.mkdirSync(__tvcPath.dirname(target), { recursive: true, mode: 0o700 });
  __tvcFs.writeFileSync(target, Buffer.from(bytes, "base64"), { mode: 0o600 });
}
process.chdir(__tvcAssetRoot);
const __tvcModuleUrl = require("node:url").pathToFileURL(__tvcPath.join(__tvcAssetRoot, "runtime.cjs")).href;
const __tvcResolve = (name) => {
  if (name === "openpond") return require("node:url").pathToFileURL(__tvcPath.join(__tvcAssetRoot, "dist", "index.js")).href;
  return require.resolve(name);
};
process.once("exit", () => __tvcFs.rmSync(__tvcAssetRoot, { recursive: true, force: true }));
`;
const result = await build({
  entryPoints: [fromRoot("examples", "turnkey-agent", "main.ts")],
  outfile: path.join(out, "app.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24.18",
  splitting: false, minify: true, keepNames: true, sourcemap: values.profile ? "external" : false, legalComments: "none", metafile: true,
  define: { "import.meta.url": "__tvcModuleUrl", "import.meta.resolve": "__tvcResolve", __OPENPOND_COMPILED_CLI__: "false" },
  banner: { js: bootstrap },
  plugins: [{
    name: "exclude-local-project-compilation",
    setup(context) {
      // The SDK's action builder is imported by the broad server graph. It is not
      // a permitted example capability, and its native compiler is unavailable in the static executable.
      // Fail closed if future code accidentally reaches it; never pretend to compile.
      context.onResolve({ filter: /^esbuild$/ }, () => ({ path: "esbuild", namespace: "tvc-unavailable" }));
      context.onLoad({ filter: /.*/, namespace: "tvc-unavailable" }, () => ({
        contents: 'export async function build() { throw new Error("Local project compilation is not available in the TVC example; execute code in the external sandbox."); }',
        loader: "js",
      }));
    },
  }],
});
if (values.profile) await writeFile(path.join(out, "metafile.json"), JSON.stringify(result.metafile));
const external = [...new Set(Object.values(result.metafile!.outputs).flatMap(output =>
  output.imports.filter(item => item.external && !isBuiltin(item.path)).map(item => item.path)))];
if (external.length) throw new Error(`TVC bundle still requires external packages: ${external.join(", ")}`);
const bytes = await readFile(path.join(out, "app.cjs"));
await writeFile(path.join(out, "bundle-inventory.json"), JSON.stringify({
  version: packageJson.version, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  inputs: Object.keys(result.metafile!.inputs).sort(), assets: Object.keys(assets).sort(), externalPackages: external,
  excludedCapabilities: ["local project compilation (esbuild)", "local terminal execution"],
}, null, 2) + "\n");
console.log(`TVC bundle: ${bytes.length} bytes; ${Object.keys(assets).length} embedded assets; no external npm packages`);
