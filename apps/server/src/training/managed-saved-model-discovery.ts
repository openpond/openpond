import { createHash } from "node:crypto";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { accountFence, clientFor, configuredAccess } from "./managed-saved-model-access.js";
import { listHostedModelProjectCatalog } from "./hosted-model-project-catalog.js";
import { chatCatalogFetch } from "./chat-catalog-fetch.js";

type Access = Awaited<ReturnType<typeof configuredAccess>>;
type Project = Awaited<ReturnType<typeof listHostedModelProjectCatalog>>["projects"][number]["project"];
type Version = NonNullable<Awaited<ReturnType<ReturnType<typeof clientFor>["modelVersion"]>>["version"]>;
type Entry = { project: Project; version: Version };
const scans = new WeakMap<SqliteStore, Map<string, { expires: number; value: Promise<Entry[]> }>>();

/** Steering, memory and learned-weight menus read the same canonical versions.
 * One scoped scan replaces three full per-project scans on every bootstrap.
 * These cached discovery records never grant inference/serving authority. */
export async function listManagedSavedModelVersions(store: SqliteStore, access: Access): Promise<Entry[]> {
  let cache = scans.get(store);
  if (!cache) { cache = new Map(); scans.set(store, cache); }
  const key = createHash("sha256").update(JSON.stringify([access.apiBaseUrl, access.teamId, access.actorId, access.token])).digest("hex");
  let entry = cache.get(key);
  if (!entry || entry.expires <= Date.now()) {
    const value = discover(store, access);
    entry = { expires: Infinity, value };
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
    const current = entry;
    void value.then(() => { current.expires = Date.now() + 60_000; }, () => { current.expires = Date.now() + 30_000; });
  }
  const result = await entry.value;
  await accountFence(access);
  return result;
}

async function discover(store: SqliteStore, access: Access): Promise<Entry[]> {
  const fence = () => accountFence(access);
  const train = clientFor(access, fence, chatCatalogFetch);
  const catalog = await listHostedModelProjectCatalog({ store, resolveAccess: async () => access, fetch: chatCatalogFetch }, { maxAgeMs: 60_000 });
  if (catalog.projects.length > 1000) throw new Error("The saved Model catalog exceeds this Desktop selection bound.");
  const results: Entry[] = [];
  let next = 0;
  let failure: unknown;
  // Bound concurrency rather than issuing one request per saved project at once.
  await Promise.all(Array.from({ length: Math.min(3, catalog.projects.length) }, async () => {
    while (next < catalog.projects.length && !failure) {
      const { project } = catalog.projects[next++]!;
      try {
        const { version } = await train.modelVersion(project.id, { teamId: access.teamId });
        if (version) results.push({ project, version });
      } catch (error) {
        if (error instanceof OpenPondTrainingApiError && [403, 404].includes(error.status)) continue;
        failure = error;
      }
    }
  }));
  if (failure) throw failure;
  await fence();
  return results.sort((a, b) => a.project.id.localeCompare(b.project.id));
}
