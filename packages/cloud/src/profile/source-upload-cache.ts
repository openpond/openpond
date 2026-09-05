import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCache, writeCache, resolveOpenPondHome } from "@openpond/persistence";

export const SOURCE_UPLOAD_CACHE_PATH = ".openpond/source-upload-cache.json";
const SOURCE_UPLOAD_CACHE_SCHEMA = "openpond.source-upload-cache.v1";

export type SourceUploadCacheFile = {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type SourceUploadCacheEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
  contentsBase64: string;
};

type SourceUploadCacheManifest = {
  schema: typeof SOURCE_UPLOAD_CACHE_SCHEMA;
  generatedAt: string;
  entries: Record<string, SourceUploadCacheEntry>;
};

export type SourceUploadMaterializedEntry = {
  path: string;
  type: "file";
  contentsBase64: string;
};

export type SourceUploadMaterializedFile = {
  file: SourceUploadCacheFile;
  entry: SourceUploadMaterializedEntry;
  sha256: string;
};

export async function readSourceUploadCache(
  rootPath: string
): Promise<Map<string, SourceUploadCacheEntry>> {
  try {
    const stored = await readCache<SourceUploadCacheManifest>(resolveOpenPondHome(), "source-upload.v1", sourceScope(rootPath));
    const parsed = stored?.payload;
    if (!parsed) return new Map();
    if (parsed.schema !== SOURCE_UPLOAD_CACHE_SCHEMA || !parsed.entries) {
      return new Map();
    }
    const cache = new Map<string, SourceUploadCacheEntry>();
    for (const [cacheKey, value] of Object.entries(parsed.entries)) {
      if (!isCacheEntry(value) || cacheKey !== cacheKeyForFile(value)) continue;
      cache.set(cacheKey, value);
    }
    return cache;
  } catch {
    return new Map();
  }
}

export async function materializeSourceUploadFile(
  file: SourceUploadCacheFile,
  cache: Map<string, SourceUploadCacheEntry>
): Promise<SourceUploadMaterializedFile> {
  const contents = await readFile(file.absolutePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const cacheKey = cacheKeyForFile({ ...file, sha256 });
  const cached = cache.get(cacheKey);
  if (cached && cached.sha256 === sha256 && createHash("sha256").update(Buffer.from(cached.contentsBase64, "base64")).digest("hex") === sha256) {
    return {
      file,
      entry: {
        path: file.path,
        type: "file",
        contentsBase64: cached.contentsBase64,
      },
      sha256: cached.sha256,
    };
  }

  return {
    file,
    entry: {
      path: file.path,
      type: "file",
      contentsBase64: contents.toString("base64"),
    },
    sha256,
  };
}

export async function writeSourceUploadCache(
  rootPath: string,
  files: SourceUploadMaterializedFile[]
): Promise<void> {
  const entries: Record<string, SourceUploadCacheEntry> = {};
  for (const item of files) {
    const cacheEntry: SourceUploadCacheEntry = {
      path: item.file.path,
      size: item.file.size,
      mtimeMs: item.file.mtimeMs,
      ctimeMs: item.file.ctimeMs,
      sha256: item.sha256,
      contentsBase64: item.entry.contentsBase64,
    };
    entries[cacheKeyForFile(cacheEntry)] = cacheEntry;
  }

  await writeCache(resolveOpenPondHome(), "source-upload.v1", sourceScope(rootPath), {
    schema: SOURCE_UPLOAD_CACHE_SCHEMA,
    generatedAt: new Date().toISOString(),
    entries,
  } satisfies SourceUploadCacheManifest);
}

function cacheKeyForFile(input: {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256?: string;
}): string {
  return `${input.path}\0${input.sha256}`;
}

function isCacheEntry(value: unknown): value is SourceUploadCacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    typeof record.size === "number" &&
    typeof record.mtimeMs === "number" &&
    typeof record.ctimeMs === "number" &&
    typeof record.sha256 === "string" &&
    typeof record.contentsBase64 === "string"
  );
}

function sourceScope(rootPath: string): string { return createHash("sha256").update(path.resolve(rootPath)).digest("hex"); }
