import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

type CopyFileOperation = (source: string, destination: string) => Promise<void>;

const STREAM_FALLBACK_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
]);

export async function copyTreePortable(
  source: string,
  destination: string,
  copyFileOperation: CopyFileOperation = copyFile,
): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Portable artifact mirror rejects symbolic links: ${source}.`);
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyTreePortable(
        path.join(source, entry),
        path.join(destination, entry),
        copyFileOperation,
      );
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Portable artifact mirror rejects unsupported filesystem entries: ${source}.`);
  }

  try {
    await copyFileOperation(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !STREAM_FALLBACK_CODES.has(code)) throw error;
    try {
      await pipeline(
        createReadStream(source),
        createWriteStream(destination, {
          flags: "w",
          mode: sourceStat.mode,
        }),
      );
    } catch (streamError) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw streamError;
    }
  }

  const destinationStat = await lstat(destination);
  if (!destinationStat.isFile() || destinationStat.size !== sourceStat.size) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw new Error(`Portable artifact mirror produced an incomplete file: ${destination}.`);
  }
}
