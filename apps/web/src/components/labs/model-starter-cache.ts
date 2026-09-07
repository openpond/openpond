import { ModelStarterCatalogPageSchema } from "openpond-sdk/model-starter-catalog";
import type { ModelStarterPage } from "../../hooks/model-starter-actions";

const MAXIMUM_CHARACTERS = 1_000_000;
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function cacheKey(scope: string, afterId?: string) {
  return `openpond.starterCatalog.v1:${JSON.stringify([scope, afterId ?? null])}`;
}

/** Only the public catalog projection is persisted. Exact package bytes,
 * private examples, verifier source and credentials never enter this cache. */
export function readModelStarterCache(storage: StorageReader, scope: string, afterId?: string): ModelStarterPage | null {
  try {
    const text = storage.getItem(cacheKey(scope, afterId));
    if (!text || text.length > MAXIMUM_CHARACTERS) return null;
    const parsed = ModelStarterCatalogPageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function writeModelStarterCache(storage: StorageWriter, scope: string, afterId: string | undefined, value: ModelStarterPage) {
  const page = ModelStarterCatalogPageSchema.parse(value);
  const text = JSON.stringify(page);
  if (text.length > MAXIMUM_CHARACTERS) return;
  try { storage.setItem(cacheKey(scope, afterId), text); }
  catch { /* Storage pressure cannot turn a successful catalog read into an error. */ }
}
