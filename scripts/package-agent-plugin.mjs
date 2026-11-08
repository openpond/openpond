import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repo, "plugins", "openpond");
const output = path.join(repo, "artifacts", "plugins");
const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(path.join(source, "mcp.json"), "utf8"));
if (manifest.name !== "openpond" || !/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error("Invalid plugin identity/version.");
if (
  Object.keys(mcp.mcpServers).join() !== "openpond" ||
  mcp.mcpServers.openpond.type !== "streamable-http" ||
  mcp.mcpServers.openpond.url !== "https://api.openpond.ai/mcp/app"
)
  throw new Error("Expected the canonical production remote MCP connection.");
const presentation = manifest.extensions["com.openai"];
if (presentation.apps || presentation.hooks)
  throw new Error("Public bundle must not contain app references or lifecycle hooks.");
for (const [field, maximum] of [
  ["displayName", 30],
  ["shortDescription", 30],
  ["longDescription", 4000],
  ["developerName", 80],
]) {
  const value = presentation.interface[field];
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`Invalid public listing field: ${field} (maximum ${maximum} characters).`);
}
for (const field of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  const url = new URL(presentation.interface[field]);
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 1024)
    throw new Error(`Invalid public listing URL: ${field}.`);
}
const cases = presentation.review?.test_cases;
for (const [kind, count] of [
  ["positive", 5],
  ["negative", 3],
]) {
  if (!Array.isArray(cases?.[kind]) || cases[kind].length !== count)
    throw new Error(`Expected ${count} ${kind} reviewer cases.`);
  const fields =
    kind === "positive"
      ? ["description", "prompt", "tools_triggered", "expected_behavior"]
      : ["description", "prompt"];
  for (const entry of cases[kind])
    if (fields.some((field) => typeof entry[field] !== "string" || !entry[field].trim()))
      throw new Error(`Incomplete ${kind} reviewer case.`);
}
const files = [
  "plugin.json",
  "mcp.json",
  "LICENSE",
  ...(await list("assets")),
  ...(await list("skills")),
].sort();
for (const reference of [
  presentation.onboardingSkill,
  presentation.interface.logo,
  presentation.interface.composerIcon,
]) {
  if (
    typeof reference !== "string" ||
    !reference.startsWith("./") ||
    reference.split("/").includes("..") ||
    !files.includes(reference.slice(2))
  )
    throw new Error("Missing or unsafe packaged reference.");
}
const skillEntrypoints = files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file));
if (!skillEntrypoints.length) throw new Error("No packaged workflow skills.");
for (const file of skillEntrypoints) {
  const text = await readFile(path.join(source, file), "utf8");
  const name = path.basename(path.dirname(file));
  if (!text.startsWith(`---\nname: ${name}\n`) || !/^description: .+$/m.test(text))
    throw new Error(`Invalid skill entrypoint: ${file}`);
}
for (const reference of new Set([
  presentation.interface.logo,
  presentation.interface.composerIcon,
])) {
  const png = await readFile(path.join(source, reference));
  if (
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(16) !== png.readUInt32BE(20) ||
    png.readUInt32BE(16) < 256 ||
    png.length > 5 * 1024 * 1024
  )
    throw new Error("Expected a square PNG asset at least 256 pixels wide and at most 5 MiB.");
}
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "openpond-plugin-"));
const destination = path.join(output, `openpond-${manifest.version}.zip`);
try {
  const content = [];
  for (const relative of files) {
    const original = path.join(source, relative);
    const target = path.join(temporary, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(original, target);
    await utimes(target, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const bytes = await readFile(target);
    content.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  await rm(destination, { force: true });
  const zip = spawnSync("zip", ["-X", "-q", destination, ...files], {
    cwd: temporary,
    encoding: "utf8",
  });
  if (zip.status !== 0)
    throw new Error(zip.stderr || "Could not create plugin ZIP; install the zip utility.");
  const receipt = {
    name: manifest.name,
    version: manifest.version,
    sha256: hash(await readFile(destination)),
    files: content,
  };
  await writeFile(`${destination}.manifest.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        path: destination,
        sha256: receipt.sha256,
        files: files.length,
        skills: skillEntrypoints.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function list(directory) {
  const result = [];
  for (const name of (await readdir(path.join(source, directory))).sort()) {
    const relative = `${directory}/${name}`;
    const stat = await lstat(path.join(source, relative));
    if (stat.isSymbolicLink())
      throw new Error(`Plugin distribution cannot contain symlinks: ${relative}`);
    if (stat.isDirectory()) result.push(...(await list(relative)));
    else if (stat.isFile()) result.push(relative);
    else throw new Error(`Unsupported plugin entry: ${relative}`);
  }
  return result;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
