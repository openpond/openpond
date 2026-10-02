import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const runtimeFolder = "appimage-runtime";
const launcher = 'const p=require("node:path");const u=require("node:url");const entry=p.join(process.env.APPDIR,"resources","cli","cli.js");process.argv.splice(1,0,entry);import(u.pathToFileURL(entry).href);';

async function privateDirectory(directory: string) {
  const absolute = resolve(directory);
  // Do not traverse symlinked storage. The owned private root then prevents
  // another OS user from replacing runtime entries during publication.
  for (let current = absolute; ; current = dirname(current)) {
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Collector runtime storage must use real directories.");
    if (dirname(current) === current) break;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error("Collector runtime storage must belong to the current user.");
  await chmod(absolute, 0o700);
}
async function digest(file: string) {
  const hash = createHash("sha256");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest("hex");
}
async function sync(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function verify(file: string, hash: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o500 || await digest(file) !== hash) throw new Error("Retained AppImage runtime failed its ownership or integrity check.");
}

/** An AppImage mount belongs to the foreground app; supervision needs its own immutable image. */
export async function retainAppImageRuntime(input: { directory: string; executable: string; args: string[] }, env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "linux" || !env.APPIMAGE || !env.APPDIR) return null;
  const mountedRoot = await realpath(env.APPDIR);
  const executable = await realpath(input.executable);
  const mountedExecutable = relative(mountedRoot, executable);
  // Merely inheriting APPIMAGE in an unrelated shell does not select this route.
  if (isAbsolute(mountedExecutable) || mountedExecutable === ".." || mountedExecutable.startsWith(`..${sep}`)) return null;
  const cli = input.args[0];
  if (!cli || await realpath(cli) !== join(mountedRoot, "resources", "cli", "cli.js")) throw new Error("AppImage collection requires its bundled CLI entrypoint.");
  const image = await realpath(env.APPIMAGE), before = await lstat(image);
  if (!before.isFile() || before.size > 1024 * 1024 * 1024) throw new Error("AppImage runtime is unavailable or exceeds the retained size limit.");
  const header = Buffer.alloc(11), handle = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2]))) throw new Error("Collector runtime must be a type-2 AppImage.");
  const hash = await digest(image);
  await privateDirectory(input.directory);
  const root = join(input.directory, runtimeFolder); await privateDirectory(root);
  const target = join(root, hash), file = join(target, "openpond.AppImage");
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid!() || (existing.mode & 0o777) !== 0o700) throw new Error("Retained runtime directory is not private.");
    await verify(file, hash);
  } else {
    const stage = await mkdtemp(join(root, ".stage-"));
    try {
      const staged = join(stage, "openpond.AppImage");
      await copyFile(image, staged, constants.COPYFILE_EXCL); await chmod(staged, 0o500);
      const after = await lstat(image);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await digest(staged) !== hash) throw new Error("AppImage changed while preparing the collector runtime; retry installation.");
      await sync(staged); await sync(stage);
      try { await rename(stage, target); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      await verify(file, hash); await sync(root);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  // Keep earlier versions until explicit uninstall. An existing process may
  // still own their mount while a newer service definition is being installed.
  return { executable: file, args: ["-e", launcher, "--", ...input.args.slice(1)] };
}

/** Called only after the platform supervisor has stopped and removed its job. */
export async function removeAppImageRuntimes(directory: string) {
  const root = join(directory, runtimeFolder);
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return;
  await privateDirectory(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error("Refusing to remove unowned collector runtime storage.");
  await rm(root, { recursive: true });
}
