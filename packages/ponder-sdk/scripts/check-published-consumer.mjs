import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const source = JSON.parse(await readFile(path.join(root, "../sdk/package.json"), "utf8"));
if (manifest.version !== source.version || manifest.dependencies?.[source.name] !== source.version) throw new Error("SDK release cohort differs");
const consumer = await mkdtemp(path.join(tmpdir(), "ponder-sdk-consumer-"));
const pack = (directory) => {
  const result = JSON.parse(execFileSync("npm", ["pack", directory, "--json", "--ignore-scripts", "--pack-destination", consumer], { encoding: "utf8" }));
  if (result.length !== 1 || !result[0].filename) throw new Error("Expected one packed distribution");
  return path.join(consumer, result[0].filename);
};
try {
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const registryDependency = process.argv.includes("--registry-dependency");
  if (registryDependency && process.argv.includes("--local-dependencies")) throw new Error("Registry and local dependency modes are exclusive");
  const dependencies = [pack(root)];
  if (!registryDependency) dependencies.push(pack(path.join(root, "../sdk")));
  if (process.argv.includes("--local-dependencies")) {
    dependencies.push(pack(path.join(root, "../evals")), pack(path.join(root, "../harness")));
  }
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...dependencies], { cwd: consumer, stdio: "inherit" });
  const subpaths = Object.keys(source.exports).filter((key) => key !== "./package.json");
  const runtime = `for (const subpath of ${JSON.stringify(subpaths)}) {
    const suffix = subpath === '.' ? '' : subpath.slice(1);
    const original = await import('openpond-sdk' + suffix);
    const wrapper = await import('ponder-sdk' + suffix);
    if (JSON.stringify(Object.keys(original).sort()) !== JSON.stringify(Object.keys(wrapper).sort())) throw new Error('Runtime exports differ: ' + subpath);
    for (const key of Object.keys(original)) if (original[key] !== wrapper[key]) throw new Error('Duplicate SDK implementation: ' + subpath + ':' + key);
  }`;
  await writeFile(path.join(consumer, "check.mjs"), runtime);
  execFileSync(process.execPath, ["check.mjs"], { cwd: consumer, stdio: "inherit" });
  // Compile only the clean external consumer via the repository's serialized
  // compiler runner. This check is opt-in; building the wrapper needs no tsc.
  if (process.argv.includes("--declarations")) {
  const declarations = subpaths.map((key, index) => {
    const suffix = key === "." ? "" : key.slice(1);
    return `import * as a${index} from 'openpond-sdk${suffix}';\nimport * as b${index} from 'ponder-sdk${suffix}';\nconst forward${index}: typeof a${index} = b${index};\nconst reverse${index}: typeof b${index} = a${index};\nvoid forward${index}; void reverse${index};`;
  }).join("\n");
  await writeFile(path.join(consumer, "consumer.ts"), declarations);
  const repository = path.resolve(root, "../..");
  execFileSync(process.execPath, [path.join(repository, "scripts/run-typescript.mjs"), "tsc", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", path.join(consumer, "consumer.ts")], { cwd: repository, stdio: "inherit" });
  }
  console.log(`Verified ${registryDependency ? "registry" : "local packed"} runtime identity for ${subpaths.length} subpaths; declarations=${process.argv.includes("--declarations")}.`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
