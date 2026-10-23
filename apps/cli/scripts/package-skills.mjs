import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Package the same maintained sources Desktop uses, without developer skills. */
export async function packageCustomerSkills({ check = false } = {}) {
  const source = path.join(cliRoot, "skills");
  const target = path.join(cliRoot, "dist", "skills");
  const inventory = JSON.parse(await readFile(path.join(source, "customer-skills.json"), "utf8"));
  const { version } = JSON.parse(await readFile(path.join(cliRoot, "package.json"), "utf8"));
  const names = inventory.skills.map(({ name }) => name);
  if (inventory.schemaVersion !== 1 || inventory.license !== "MIT" || new Set(names).size !== 5 || names.includes("openpond-desktop-harness") || names.some(name => !/^openpond-[a-z-]+$/.test(name))) {
    throw new Error("Invalid customer skill inventory; expected five distinct customer skills.");
  }
  const files = [];
  for (const name of names) {
    const entrypoint = await readFile(path.join(source, name, "SKILL.md"), "utf8");
    if (!entrypoint.startsWith(`---\nname: ${name}\n`)) throw new Error(`Skill identity mismatch: ${name}`);
    for (const relative of await listFiles(path.join(source, name))) {
      const bytes = await readFile(path.join(source, name, relative));
      files.push({ path: `${name}/${relative}`, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  const license = await readFile(path.join(cliRoot, "LICENSE"));
  const manifest = `${JSON.stringify({ ...inventory, package: "openpond", version, sourceFiles: files, licenseSha256: hash(license) }, null, 2)}\n`;
  if (check) {
    if (await readFile(path.join(target, "manifest.json"), "utf8") !== manifest) throw new Error("Customer skills manifest is stale; run pnpm run skills:package.");
    const expected = [...files.map(file => file.path), "LICENSE", "manifest.json"].sort();
    if (JSON.stringify(await listFiles(target)) !== JSON.stringify(expected)) throw new Error("Customer skill pack contains missing or unexpected files.");
    for (const file of files) {
      if (hash(await readFile(path.join(target, file.path))) !== file.sha256) throw new Error(`Packaged skill differs from source: ${file.path}`);
    }
    if (hash(await readFile(path.join(target, "LICENSE"))) !== hash(license)) throw new Error("Packaged MIT license differs from source.");
  } else {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const name of names) await cp(path.join(source, name), path.join(target, name), { recursive: true, dereference: false });
    await writeFile(path.join(target, "LICENSE"), license);
    await writeFile(path.join(target, "manifest.json"), manifest);
  }
  console.log(`${check ? "Verified" : "Packaged"} openpond@${version}: ${names.length} customer skills, ${files.length} source files, MIT; manifest sha256:${hash(manifest)}`);
}

async function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = await lstat(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Skill distribution cannot contain symlinks: ${relative}`);
    if (stat.isDirectory()) files.push(...await listFiles(root, relative));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`Unsupported skill distribution entry: ${relative}`);
  }
  return files.sort();
}

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await packageCustomerSkills({ check: process.argv.includes("--check") });
}
