import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { t, x } from "tar";
import { z } from "zod";
import { withFileLock } from "@openpond/persistence";
import type { AntigravityRuntimeState } from "@openpond/contracts";
import { antigravityVersionSupported } from "./antigravity-profile.js";
import { readBoundedResponse } from "./acp-registry.js";

const MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const MAX_DOWNLOAD = 512 * 1024 * 1024;
const MAX_EXPANDED = 1536 * 1024 * 1024;
const releaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url(),
  sha512: z.string().regex(/^[a-fA-F0-9]{128}$/),
});
type Release = z.infer<typeof releaseSchema>;
export type AntigravityInstallation = Release & { command: string };
const root = (home: string) => join(home, "runtime", "antigravity");

async function target() {
  if (
    !["darwin", "linux", "win32"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error("Antigravity supports macOS, Linux and Windows on x64 or ARM64.");
  const musl =
    process.platform === "linux" &&
    (await access(`/lib/libc.musl-${process.arch === "x64" ? "x86_64" : "aarch64"}.so.1`).then(
      () => true,
      () => false,
    ));
  return {
    target: `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : "arm64"}${musl ? "_musl" : ""}`,
    folder: `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm" : "x64"}${musl ? "-musl" : ""}`,
    filename: `cli_${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"}_${process.arch}${musl ? "_musl" : ""}.${process.platform === "win32" ? "exe" : "tar.gz"}`,
  };
}

export async function latestAntigravityRelease(signal?: AbortSignal): Promise<Release> {
  const platform = await target();
  const response = await fetch(`${MANIFEST_BASE}/${platform.target}.json`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Could not check Google's Antigravity release channel.");
  const release = releaseSchema.parse(
    JSON.parse(Buffer.from(await readBoundedResponse(response, 16 * 1024)).toString("utf8")),
  );
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${release.version}-`;
  const suffix = release.url.startsWith(prefix) ? release.url.slice(prefix.length) : "";
  const releaseNumber = suffix.split("/")[0];
  if (
    !releaseNumber ||
    !/^\d+$/.test(releaseNumber) ||
    suffix !== `${releaseNumber}/${platform.folder}/${platform.filename}`
  )
    throw new Error("Google's Antigravity manifest contains an unexpected download address.");
  if (!antigravityVersionSupported(release.version))
    throw new Error(
      "Antigravity 1.5.12 or newer is required. Google's current release is too old.",
    );
  return { ...release, sha512: release.sha512.toLowerCase() };
}

export async function readAntigravityInstallation(
  home: string,
): Promise<AntigravityInstallation | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root(home), "active.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The saved Antigravity installation is invalid. Reinstall it in Providers.");
  }
  const release = releaseSchema.parse(value);
  const command = join(
    root(home),
    "versions",
    release.sha512.toLowerCase().slice(0, 64),
    process.platform === "win32" ? "agy.exe" : "antigravity",
  );
  try {
    if (!(await lstat(command)).isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!antigravityVersionSupported(release.version)) return null;
  return { ...release, command };
}

function archivePath(directory: string, name: string) {
  const result = resolve(directory, name);
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..") ||
    (result !== directory && !result.startsWith(`${directory}${sep}`))
  )
    throw new Error("The Antigravity archive contains an unsafe path.");
  return result;
}

export async function installAntigravityRuntime(
  home: string,
  state: AntigravityRuntimeState,
  signal: AbortSignal,
): Promise<AntigravityInstallation> {
  const directory = root(home);
  await mkdir(join(directory, "versions"), { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, "installation"), async () => {
    state.phase = "checking";
    state.error = null;
    state.downloadedBytes = 0;
    state.totalBytes = null;
    const release = await latestAntigravityRelease(signal);
    state.latestVersion = release.version;
    const current = await readAntigravityInstallation(home);
    if (current?.sha512 === release.sha512) {
      state.version = current.version;
      state.phase = "idle";
      return current;
    }
    const destination = join(directory, "versions", release.sha512.slice(0, 64));
    const staging = await mkdtemp(join(directory, ".install-"));
    try {
      state.phase = "downloading";
      const response = await fetch(release.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new Error("Could not download Antigravity from Google.");
      const declaredSize = Number(response.headers.get("content-length"));
      if (declaredSize > MAX_DOWNLOAD)
        throw new Error("The Antigravity download exceeds the installation limit.");
      state.totalBytes = declaredSize > 0 ? declaredSize : null;
      const hash = createHash("sha512");
      const archive = join(staging, "download");
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            state.downloadedBytes += chunk.length;
            if (state.downloadedBytes > MAX_DOWNLOAD) {
              callback(new Error("The Antigravity download exceeds the installation limit."));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      if (hash.digest("hex") !== release.sha512)
        throw new Error(
          "The Antigravity download failed Google's checksum verification. Nothing was installed.",
        );
      state.phase = "installing";
      const unpack = join(staging, "runtime");
      await mkdir(unpack, { mode: 0o700 });
      const executableName = process.platform === "win32" ? "agy.exe" : "antigravity";
      if (process.platform === "win32") await rename(archive, join(unpack, executableName));
      else {
        let expanded = 0;
        let entries = 0;
        let invalid: Error | null = null;
        await t({
          file: archive,
          gzip: true,
          strict: true,
          onentry(entry) {
            try {
              archivePath(unpack, entry.path);
              expanded += entry.size;
              if (
                ++entries > 20_000 ||
                expanded > MAX_EXPANDED ||
                !["File", "Directory"].includes(entry.type)
              )
                throw new Error(
                  "The Antigravity archive exceeds limits or contains unsupported links.",
                );
            } catch (error) {
              invalid = error as Error;
            }
          },
        });
        if (invalid) throw invalid;
        signal.throwIfAborted();
        await x({
          file: archive,
          cwd: unpack,
          gzip: true,
          strict: true,
          preservePaths: false,
          noChmod: true,
        });
      }
      const executable = join(unpack, executableName);
      if (!(await lstat(executable)).isFile())
        throw new Error("The Antigravity archive is missing its executable.");
      await chmod(executable, 0o700);
      signal.throwIfAborted();
      try {
        const { stdout } = await promisify(execFile)(executable, ["--version"], {
          env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
          timeout: 120_000,
          maxBuffer: 16 * 1024,
          signal,
          windowsHide: true,
        });
        if (stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== release.version)
          throw new Error("version mismatch");
      } catch {
        throw new Error(
          "The downloaded Antigravity runtime could not start or reported the wrong version. The previous installation is unchanged.",
        );
      }
      try {
        await rename(unpack, destination);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const pending = join(directory, `.active-${randomUUID()}.json`);
      await writeFile(pending, `${JSON.stringify(release)}\n`, { mode: 0o600, flag: "wx" });
      await rename(pending, join(directory, "active.json"));
      state.version = release.version;
      state.phase = "idle";
      return { ...release, command: join(destination, executableName) };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}
