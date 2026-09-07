import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelStarterCatalogPageSchema, type OpenPondModelStarterCatalogClient } from "openpond-sdk/model-starter-catalog";

type Page = Awaited<ReturnType<OpenPondModelStarterCatalogClient["list"]>>;
type Query = { limit?: number; afterId?: string };
const MAXIMUM_BYTES = 4 * 1024 * 1024;

/** Catalog metadata survives the packaged renderer's changing localhost origin.
 * The authenticated runtime resolves the API/team scope before reading this cache.
 * Packages, credentials and verifier-private data are never persisted here. */
export function createModelStarterCatalogCache(home: string) {
  const directory = join(home, "cache", "model-starter-catalog");
  const inFlight = new Map<string, Promise<Page>>();
  return {
    async list(input: { apiBaseUrl: string; teamId: string; query: Query; fresh?: boolean; fetch: () => Promise<Page> }): Promise<Page> {
      const identity = JSON.stringify([input.apiBaseUrl.replace(/\/+$/, ""), input.teamId, input.query.limit ?? 30, input.query.afterId ?? null]);
      const key = createHash("sha256").update(identity).digest("hex");
      const file = join(directory, `${key}.json`);
      if (!input.fresh) {
        try {
          const info = await stat(file);
          if (info.isFile() && info.size <= MAXIMUM_BYTES) {
            const text = await readFile(file, "utf8");
            if (Buffer.byteLength(text) <= MAXIMUM_BYTES) {
              let value: unknown;
              try { value = JSON.parse(text); } catch { value = null; }
              const cached = ModelStarterCatalogPageSchema.safeParse(value);
              if (cached.success) return cached.data;
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const refreshing = (async () => {
        const page = ModelStarterCatalogPageSchema.parse(await input.fetch());
        const text = JSON.stringify(page);
        if (Buffer.byteLength(text) > MAXIMUM_BYTES) throw new Error("Starter catalog cache page exceeds its size limit.");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
        return page;
      })();
      inFlight.set(key, refreshing);
      try { return await refreshing; }
      finally { if (inFlight.get(key) === refreshing) inFlight.delete(key); }
    },
  };
}
