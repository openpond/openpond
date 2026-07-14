import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const version = "1.7.12";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
const checksums: Record<string, string> = {
  darwin_amd64: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  darwin_arm64: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  linux_amd64: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  linux_arm64: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
};

if (!platform || !architecture) {
  throw new Error(`actionlint ${version} runner does not support ${process.platform}/${process.arch}`);
}

const target = `${platform}_${architecture}`;
const cacheDirectory = path.join(root, ".cache", "actionlint", version, target);
const executable = path.join(cacheDirectory, "actionlint");

if (!await exists(executable)) await install(target, cacheDirectory, executable);
const workflowDirectory = path.join(root, ".github", "workflows");
const workflows = (await fs.readdir(workflowDirectory))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => path.join(".github", "workflows", name));
await run(executable, workflows);

async function install(targetName: string, directory: string, destination: string): Promise<void> {
  const archiveName = `actionlint_${version}_${targetName}.tar.gz`;
  const url = `https://github.com/rhysd/actionlint/releases/download/v${version}/${archiveName}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== checksums[targetName]) {
    throw new Error(`checksum mismatch for ${archiveName}: expected ${checksums[targetName]}, received ${actual}`);
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-actionlint-"));
  const archivePath = path.join(temporaryDirectory, archiveName);
  try {
    await fs.writeFile(archivePath, archive);
    await fs.mkdir(directory, { recursive: true });
    await run("tar", ["-xzf", archivePath, "-C", directory, "actionlint"]);
    await fs.chmod(destination, 0o755);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit", shell: false });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`${command} failed with ${signal ?? `exit code ${code}`}`);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}
