import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(await readFile(path.join(root, "../sdk/package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (manifest.name !== "ponder-sdk" || source.name !== "openpond-sdk" ||
    manifest.version !== source.version || manifest.dependencies?.[source.name] !== source.version) {
  throw new Error("Ponder must use the exact corresponding OpenPond SDK release.");
}
if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(Object.keys(source.exports).sort())) {
  throw new Error("Ponder public subpaths differ from the OpenPond SDK manifest.");
}
// Only re-export maintained public entrypoints. Never bundle a second SDK or
// resolve the monorepo's private implementation from a published consumer.
const outputs = [];
for (const [subpath, target] of Object.entries(source.exports)) {
  if (subpath === "./package.json") continue;
  if (!target || typeof target !== "object" || typeof target.import !== "string" || typeof target.types !== "string") {
    throw new Error(`Unsupported public export shape: ${subpath}`);
  }
  const entry = subpath === "." ? "index" : subpath.slice(2);
  if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(entry)) throw new Error("Unsafe export path");
  const expected = { types: `./dist/${entry}.d.ts`, import: `./dist/${entry}.js` };
  if (JSON.stringify(manifest.exports[subpath]) !== JSON.stringify(expected)) throw new Error(`Invalid wrapper export: ${subpath}`);
  // Current SDK entrypoints have named exports. The packed consumer check
  // compares every runtime key, so a future default export cannot disappear.
  const content = `export * from ${JSON.stringify(source.name + (subpath === "." ? "" : subpath.slice(1)))};\n`;
  outputs.push([entry, content]);
}
await rm(path.join(root, "dist"), { recursive: true, force: true });
for (const [entry, content] of outputs) {
  const stem = path.join(root, "dist", entry);
  await mkdir(path.dirname(stem), { recursive: true });
  await writeFile(`${stem}.js`, content);
  await writeFile(`${stem}.d.ts`, content);
}
console.log(`Prepared ${outputs.length} exact-version Ponder entrypoints (${source.version}).`);
