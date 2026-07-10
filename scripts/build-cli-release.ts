import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

type ReleaseInventory = {
  schemaVersion: 1;
  os: string;
  arch: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};

const root = path.resolve(import.meta.dir, "..");
const releaseDir = path.resolve(valueAfter("--release-dir") ?? path.join(root, "release"));
const stageDir = path.resolve(valueAfter("--stage-dir") ?? path.join(root, "release-cli"));
const releaseOs = valueAfter("--os") ?? releaseOsName();
const releaseArch = valueAfter("--arch") ?? releaseArchName();
const artifactName = `openpond-cli-${releaseOs}-${releaseArch}.tar.gz`;
const artifactPath = path.join(releaseDir, artifactName);

assertNativeTarget(releaseOs, releaseArch);
await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });

await run(process.execPath, [
  path.join(root, "scripts", "build-compiled-cli.ts"),
  "--outfile",
  path.join(stageDir, "openpond"),
]);
await chmod(path.join(stageDir, "openpond"), 0o755);
await symlink("openpond", path.join(stageDir, "op"));
await cp(path.join(root, "apps", "web", "dist"), path.join(stageDir, "web"), { recursive: true });
await cp(path.join(root, "apps", "cli", "package.json"), path.join(stageDir, "package.json"));
await stageNodePtyHelper();

const inventory: ReleaseInventory = {
  schemaVersion: 1,
  os: releaseOs,
  arch: releaseArch,
  files: await inventoryFiles(),
};
await writeFile(
  path.join(stageDir, "cli-release-inventory.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
  "utf8",
);

await rm(artifactPath, { force: true });
await run("tar", ["-czf", artifactPath, "-C", stageDir, "."]);
console.log(`Built ${path.relative(root, artifactPath)} with ${inventory.files.length} staged files.`);

async function stageNodePtyHelper(): Promise<void> {
  if (process.platform !== "darwin") return;
  const helper = path.join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (!existsSync(helper)) throw new Error(`node-pty spawn helper is missing: ${helper}`);
  const destination = path.join(stageDir, "runtime", "node-pty", "spawn-helper");
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(helper, destination);
  await chmod(destination, 0o755);
}

async function inventoryFiles(): Promise<ReleaseInventory["files"]> {
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: stageDir, onlyFiles: true }));
  return Promise.all(files.sort().map(async (relativePath) => {
    const contents = await readFile(path.join(stageDir, relativePath));
    return {
      path: relativePath.replaceAll(path.sep, "/"),
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  }));
}

function assertNativeTarget(os: string, arch: string): void {
  if (os !== releaseOsName() || arch !== releaseArchName()) {
    throw new Error(`compiled CLI native addons require the current target ${releaseOsName()}-${releaseArchName()}`);
  }
}

function releaseOsName(): string {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  throw new Error(`unsupported compiled CLI release OS: ${process.platform}`);
}

function releaseArchName(): string {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`unsupported compiled CLI release architecture: ${process.arch}`);
}

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function run(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${path.basename(command)} exited with code ${exitCode}`);
}
