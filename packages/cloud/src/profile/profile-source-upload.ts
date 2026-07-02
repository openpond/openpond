import { stat } from "node:fs/promises";
import path from "node:path";

import { runGitCommand } from "./profile-git.js";
import {
  materializeSourceUploadFile,
  readSourceUploadCache,
  SOURCE_UPLOAD_CACHE_PATH,
  writeSourceUploadCache,
  type SourceUploadCacheFile,
} from "./source-upload-cache.js";

export type OpenPondProfileSourceUploadEntry = {
  path: string;
  type: "file";
  contentsBase64: string;
};

export type OpenPondProfileSourceUpload = {
  entries: OpenPondProfileSourceUploadEntry[];
  fileCount: number;
  totalBytes: number;
  limits: OpenPondProfileSourceUploadLimits;
  transport: OpenPondProfileSourceUploadTransport;
};

export type OpenPondProfileSourceUploadLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  concurrency: number;
};

export type OpenPondProfileSourceUploadTransport = {
  mode: "single_json_payload";
  chunkingSupported: false;
};

export const PROFILE_SOURCE_UPLOAD_MAX_FILES = 1500;
export const PROFILE_SOURCE_UPLOAD_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PROFILE_SOURCE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const PROFILE_SOURCE_UPLOAD_CONCURRENCY = 8;
export const PROFILE_SOURCE_UPLOAD_LIMITS: OpenPondProfileSourceUploadLimits = {
  maxFiles: PROFILE_SOURCE_UPLOAD_MAX_FILES,
  maxFileBytes: PROFILE_SOURCE_UPLOAD_MAX_FILE_BYTES,
  maxTotalBytes: PROFILE_SOURCE_UPLOAD_MAX_BYTES,
  concurrency: PROFILE_SOURCE_UPLOAD_CONCURRENCY,
};
export const PROFILE_SOURCE_UPLOAD_TRANSPORT: OpenPondProfileSourceUploadTransport = {
  mode: "single_json_payload",
  chunkingSupported: false,
};

type ProfileSourceUploadFile = {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
};

export async function collectProfileSourceUploadEntries(repoPath: string): Promise<OpenPondProfileSourceUpload> {
  const files = await runGitCommand(repoPath, ["ls-files", "-z"]);
  if (files.code !== 0) {
    throw new Error(files.stderr.trim() || files.stdout.trim() || "git ls-files failed for profile source upload");
  }

  const sourcePaths = files.stdout
    .split("\0")
    .map((filePath) => filePath.trim())
    .filter(Boolean)
    .filter((filePath) => {
      const normalized = filePath.replace(/\\/g, "/");
      return isSafeProfileSourcePath(normalized) && !shouldSkipProfileSourcePath(normalized);
    })
    .sort();

  if (sourcePaths.length === 0) {
    throw new Error("No committed profile source files found to upload.");
  }
  if (sourcePaths.length > PROFILE_SOURCE_UPLOAD_MAX_FILES) {
    throw new Error(`Too many profile source files to upload: ${sourcePaths.length} > ${PROFILE_SOURCE_UPLOAD_MAX_FILES}`);
  }

  const filesToUpload = (
    await mapWithConcurrency(sourcePaths, PROFILE_SOURCE_UPLOAD_CONCURRENCY, async (sourcePath) => {
      const absolutePath = path.resolve(repoPath, sourcePath);
      const relative = path.relative(repoPath, absolutePath).replace(/\\/g, "/");
      if (!isSafeProfileSourcePath(relative)) {
        throw new Error(`Profile source path escapes repo: ${sourcePath}`);
      }
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) return null;
      if (fileStat.size > PROFILE_SOURCE_UPLOAD_MAX_FILE_BYTES) {
        throw new Error(`Profile source file is too large: ${sourcePath} (${fileStat.size} bytes)`);
      }
      return {
        path: relative,
        absolutePath,
        size: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
      } satisfies ProfileSourceUploadFile;
    })
  ).filter((file): file is ProfileSourceUploadFile => file !== null);

  let totalBytes = 0;
  for (const file of filesToUpload) {
    totalBytes += file.size;
    if (totalBytes > PROFILE_SOURCE_UPLOAD_MAX_BYTES) {
      throw new Error(`Profile source upload is too large: ${totalBytes} > ${PROFILE_SOURCE_UPLOAD_MAX_BYTES}`);
    }
  }

  const cache = await readSourceUploadCache(repoPath);
  const materialized = await mapWithConcurrency(filesToUpload, PROFILE_SOURCE_UPLOAD_CONCURRENCY, async (file) =>
    materializeSourceUploadFile(file as SourceUploadCacheFile, cache)
  );
  await writeSourceUploadCache(repoPath, materialized).catch(() => {});
  const entries = materialized.map((item) => item.entry);

  return {
    entries,
    fileCount: entries.length,
    totalBytes,
    limits: PROFILE_SOURCE_UPLOAD_LIMITS,
    transport: PROFILE_SOURCE_UPLOAD_TRANSPORT,
  };
}

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );
  return results;
}

function isSafeProfileSourcePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")
  );
}

function shouldSkipProfileSourcePath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some((segment, index, segments) => {
    const lower = segment.toLowerCase();
    if (lower === ".git" || lower === "node_modules" || lower === ".bun") return true;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (filePath.replace(/\\/g, "/") === SOURCE_UPLOAD_CACHE_PATH) return true;
    if (lower !== ".openpond") return false;
    const nested = segments[index + 1]?.toLowerCase();
    return (
      nested === "goals" ||
      nested === "traces" ||
      nested === "vendor" ||
      nested === "eval-results.json" ||
      nested === "artifact-index.json"
    );
  });
}
