import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DesktopUpdateError } from "./desktop-update-controller.js";

const execFileAsync = promisify(execFile);

export async function verifyDownloadedFile(file: string, sha512: string): Promise<void> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("base64") !== sha512) {
    throw new DesktopUpdateError("The downloaded update failed verification. Download it again before restarting.", "download");
  }
}

export async function prepareAppImageUpdate(downloadedFile: string, appImageFile: string, sha512: string): Promise<string> {
  const destination = await fs.realpath(appImageFile);
  const staged = path.join(path.dirname(destination), `.${path.basename(destination)}.update-${randomUUID()}`);
  try {
    await fs.copyFile(downloadedFile, staged, fs.constants.COPYFILE_EXCL);
    await verifyDownloadedFile(staged, sha512);
    await fs.chmod(staged, 0o755);
    return staged;
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => undefined);
    if (error instanceof DesktopUpdateError) throw error;
    throw new DesktopUpdateError("The AppImage could not be prepared for update. Make sure its folder is writable and has enough free space.");
  }
}

// Replace on the same filesystem, keeping the old executable until the copy is
// complete and verified. Preserve its name so shortcuts and symlinks still work.
export function installPreparedAppImage(staged: string, destination: string): void {
  renameSync(staged, destination);
}

type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export async function installDebUpdate(input: {
  file: string;
  sha512: string;
  packageName: "openpond" | "openpond-nightly";
  version: string;
  arch: "x64" | "arm64";
  run?: CommandRunner;
  elevated?: boolean;
}): Promise<void> {
  const run: CommandRunner = input.run ?? ((file, args) => execFileAsync(file, args, {
    timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024,
  }));
  const directory = await fs.mkdtemp(path.join(tmpdir(), "openpond-update-"));
  const file = path.join(directory, "update.deb");
  try {
    await fs.copyFile(input.file, file);
    await verifyDownloadedFile(file, input.sha512);
    const metadata = await run("/usr/bin/dpkg-deb", [
      "--show", "--showformat", "${Package}\n${Version}\n${Architecture}\n", file,
    ]);
    const expectedArch = input.arch === "x64" ? "amd64" : "arm64";
    // electron-builder uses Debian's '~' prerelease ordering, not semver '-'.
    const debVersion = input.version.replace(/-/g, "~");
    if (metadata.stdout.trim() !== `${input.packageName}\n${debVersion}\n${expectedArch}`) {
      throw new DesktopUpdateError("The downloaded package does not match this OpenPond installation. Download the update again.", "download");
    }
    const args = ["install", "--yes", "--no-remove", file];
    const elevated = input.elevated ?? process.getuid?.() === 0;
    // Never invoke a shell or accept a command/path from renderer IPC. Let the
    // system authorization agent prompt, and keep the old app open on cancel.
    await run(elevated ? "/usr/bin/apt-get" : "/usr/bin/pkexec", elevated ? args : ["/usr/bin/apt-get", ...args]);
  } catch (error) {
    if (error instanceof DesktopUpdateError) throw error;
    throw new DesktopUpdateError("Linux could not authorize or install the update. Try again with your system authorization agent, or update OpenPond through your package manager.");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
