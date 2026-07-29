import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_AGENT_SDK_ARCHIVE_BYTES = 20_000_000;

export function createWorkAgentSdkArchiveLoader(input: {
  storeDir: string;
  packagePath?: string | null;
  sourceRoot?: string | null;
}) {
  let pending: Promise<Buffer> | null = null;
  return async () => {
    pending ??= loadWorkAgentSdkArchive(input);
    try {
      return await pending;
    } catch (error) {
      pending = null;
      throw error;
    }
  };
}

async function loadWorkAgentSdkArchive(input: {
  storeDir: string;
  packagePath?: string | null;
  sourceRoot?: string | null;
}): Promise<Buffer> {
  const stagedPath =
    input.packagePath?.trim() ||
    process.env.OPENPOND_AGENT_SDK_PACKAGE?.trim() ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "work-assets",
      "openpond-agent-sdk.tgz"
    );
  const staged = await readBoundedArchive(stagedPath);
  if (staged) return staged;

  const sourceRoot = await resolveAgentSdkSourceRoot(input.sourceRoot);
  const distCli = path.join(sourceRoot, "dist", "cli.js");
  if (!(await isFile(distCli))) {
    await execFileAsync(packageManagerCommand("pnpm"), [
      "--dir",
      sourceRoot,
      "run",
      "build",
    ]);
  }
  if (!(await isFile(distCli))) {
    throw new Error("OpenPond Agent SDK build did not produce dist/cli.js.");
  }

  const cacheRoot = path.join(input.storeDir, "work", "assets");
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const packRoot = await fs.mkdtemp(path.join(cacheRoot, "agent-sdk-pack-"));
  try {
    const { stdout } = await execFileAsync(packageManagerCommand("npm"), [
      "pack",
      sourceRoot,
      "--json",
      "--pack-destination",
      packRoot,
    ]);
    const packed = JSON.parse(stdout) as Array<{ filename?: string }>;
    const filename = packed[0]?.filename;
    if (!filename) throw new Error("npm pack did not return an SDK archive.");
    const bytes = await readBoundedArchive(path.join(packRoot, filename));
    if (!bytes) throw new Error("Packed OpenPond Agent SDK archive is empty.");
    return bytes;
  } finally {
    await fs.rm(packRoot, { recursive: true, force: true });
  }
}

async function resolveAgentSdkSourceRoot(
  override?: string | null
): Promise<string> {
  const candidates = [
    override?.trim(),
    process.env.OPENPOND_AGENT_SDK_ROOT?.trim(),
    path.join(process.cwd(), "packages", "agent-sdk"),
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/agent-sdk"
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await isFile(path.join(candidate, "package.json"))) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    "OpenPond Agent SDK assets are unavailable. Rebuild the desktop runtime."
  );
}

async function readBoundedArchive(filePath: string): Promise<Buffer | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size <= 0 || stat.size > MAX_AGENT_SDK_ARCHIVE_BYTES) {
    throw new Error("OpenPond Agent SDK archive has an invalid size.");
  }
  return fs.readFile(filePath);
}

async function isFile(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

function packageManagerCommand(name: "npm" | "pnpm"): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}
