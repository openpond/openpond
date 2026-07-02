import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: string;
  version?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function workspacePackagePaths(root: string, workspaces: string[]): Promise<string[]> {
  const packagePaths: string[] = [];
  for (const workspace of workspaces) {
    if (!workspace.endsWith("/*")) continue;
    const dirname = workspace.slice(0, -2);
    const workspaceRoot = path.join(root, dirname);
    for (const entry of await fs.readdir(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = path.join(workspaceRoot, entry.name, "package.json");
      if (await fileExists(packagePath)) packagePaths.push(packagePath);
    }
  }
  return packagePaths.sort();
}

function gitOutput(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const releaseAssetsDir = path.resolve(root, readArg("release-assets") ?? "release-assets");
const outputPath = path.join(releaseAssetsDir, readArg("output") ?? "release-inventory.json");
const rootPackage = await readJson<PackageJson>(path.join(root, "package.json"));
const workspacePaths = await workspacePackagePaths(root, rootPackage.workspaces ?? []);
const workspacePackages = await Promise.all(
  workspacePaths.map(async (packagePath) => {
    const pkg = await readJson<PackageJson>(packagePath);
    return {
      path: path.relative(root, packagePath),
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    };
  })
);

const artifactNames = (await fs.readdir(releaseAssetsDir)).filter(
  (name) => name !== path.basename(outputPath) && name !== "SHA256SUMS.txt"
);
const artifacts = await Promise.all(
  artifactNames.sort().map(async (name) => {
    const filePath = path.join(releaseAssetsDir, name);
    const stat = await fs.stat(filePath);
    return {
      name,
      size: stat.size,
      sha256: await hashFile(filePath),
    };
  })
);

const bunLockPath = path.join(root, "bun.lock");
const inventory = {
  generatedAt: new Date().toISOString(),
  app: {
    name: rootPackage.name,
    version: readArg("version") ?? rootPackage.version,
    channel: readArg("channel") ?? process.env.OPENPOND_APP_CHANNEL ?? null,
  },
  build: {
    commit: process.env.GITHUB_SHA ?? gitOutput(root, ["rev-parse", "HEAD"]),
    shortCommit: gitOutput(root, ["rev-parse", "--short", "HEAD"]),
    ref: process.env.GITHUB_REF ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    bun: typeof Bun === "undefined" ? null : Bun.version,
    electron: rootPackage.devDependencies?.electron ?? null,
  },
  rootPackage: {
    dependencies: rootPackage.dependencies ?? {},
    devDependencies: rootPackage.devDependencies ?? {},
  },
  workspaces: workspacePackages,
  lockfile: {
    path: "bun.lock",
    sha256: await hashFile(bunLockPath),
  },
  artifacts,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
console.log(`Wrote release inventory to ${path.relative(root, outputPath)}`);
