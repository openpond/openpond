import { expect, test, vi } from "vitest";
import type { SqliteStore } from "../store/store.js";
const mocks = vi.hoisted(() => ({
  access: { apiBaseUrl: "https://api.example.test", teamId: "team", actorId: "actor", token: "token" },
  fence: vi.fn(async (_access: unknown) => {}), read: vi.fn(async (_id: string): Promise<{version: any}> => ({ version: null })),
  serving: vi.fn(async () => ({ schemaVersion: "openpond.weightSpaceModelServing.v1", version: { schemaVersion: "openpond.weightSpaceModelVersion.v1", contentHash: "c".repeat(64), ownerUserId: "actor" }, state: "unavailable" })),
  catalog: vi.fn(async () => ({ projects: Array.from({ length: 12 }, (_, i) => ({ project: { id: `model-${i}`, name: `Model ${i}` } })) })),
}));
vi.mock("./managed-saved-model-access.js", () => ({
  configuredAccess: async () => mocks.access, identity: (access: typeof mocks.access) => ({ teamId: access.teamId, actorId: access.actorId, apiOrigin: access.apiBaseUrl }),
  accountFence: mocks.fence, clientFor: () => ({ modelVersion: mocks.read, savedModelServing: mocks.serving }),
}));
vi.mock("./hosted-model-project-catalog.js", () => ({ listHostedModelProjectCatalog: mocks.catalog }));
import { listManagedSavedModelVersions } from "./managed-saved-model-discovery.js";
import { listManagedSteeringChatModels } from "./managed-steering-chat.js";
import { listManagedEngramChatModels } from "./managed-engram-chat.js";
import { listManagedWeightChatModels, resolveManagedWeightChat } from "./managed-weight-chat.js";

// Failure story: three consumers scanned every model separately, exhausted the
// shared read allowance and held startup. Join one scan, bound concurrency and
// keep credential/account changes out of both in-flight and cached results.
test("saved-model discovery shares a bounded scan and reauthorizes cache hits", async () => {
  mocks.read.mockClear(); mocks.catalog.mockClear(); mocks.fence.mockClear();
  let active = 0, maximum = 0;
  mocks.read.mockImplementation(async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return { version: null }; });
  const access = { apiBaseUrl: "https://api.example.test", teamId: "team", actorId: "actor", token: "token" };
  const store = {} as SqliteStore;
  await Promise.all(Array.from({ length: 3 }, () => listManagedSavedModelVersions(store, access)));
  expect(mocks.catalog).toHaveBeenCalledTimes(1);
  expect(mocks.read).toHaveBeenCalledTimes(12);
  expect(maximum).toBeLessThanOrEqual(3);
  await listManagedSavedModelVersions(store, access);
  expect(mocks.read).toHaveBeenCalledTimes(12);
  await listManagedSavedModelVersions(store, { ...access, token: "rotated" });
  expect(mocks.read).toHaveBeenCalledTimes(24);
  mocks.fence.mockRejectedValueOnce(new Error("account changed"));
  await expect(listManagedSavedModelVersions(store, access)).rejects.toThrow("account changed");
});

// Failure story: per-model serving reads delayed the entire picker and made a
// stopped runtime hide saved records. Listing locators must never grant a send.
test("menus list exact saved locators without probing serving, while sending still checks current authority", async () => {
  mocks.serving.mockClear();
  mocks.read.mockImplementation(async id => ({ version: id === "model-0"
    ? { schemaVersion: "openpond.steeringModelVersion.v1", publication: { ownerUserId: "actor" }, contentHash: "a".repeat(64) }
    : id === "model-1" ? { schemaVersion: "openpond.engramModelVersion.v1", ownerUserId: "actor", contentHash: "b".repeat(64) }
    : id === "model-2" ? { schemaVersion: "openpond.weightSpaceModelVersion.v1", ownerUserId: "actor", contentHash: "c".repeat(64) } : null }));
  const entries = new Map<string, unknown>();
  const store = {
    getCacheEntry: async (type: string, id: string) => entries.get(`${type}:${id}`) ?? null,
    setCacheEntry: async (type: string, id: string, payload: unknown) => { entries.set(`${type}:${id}`, { payload }); },
  } as unknown as SqliteStore;
  const [steering, memory, weights] = await Promise.all([
    listManagedSteeringChatModels(store, "team"), listManagedEngramChatModels(store, "team"), listManagedWeightChatModels(store, "team"),
  ]);
  expect([steering.length, memory.length, weights.length]).toEqual([1, 1, 1]);
  expect(weights[0]!.raw?.savedModel).toEqual({ modelProjectId: "model-2", versionHash: "c".repeat(64) });
  expect(mocks.serving).not.toHaveBeenCalled();
  await expect(resolveManagedWeightChat({ store, modelId: weights[0]!.id, selectedTeamId: "other-team", options: {} })).rejects.toThrow("original workspace");
  expect(mocks.serving).not.toHaveBeenCalled();
  await expect(resolveManagedWeightChat({ store, modelId: weights[0]!.id, selectedTeamId: "team", options: {} })).rejects.toThrow("Enable qualified serving");
  expect(mocks.serving).toHaveBeenCalledExactlyOnceWith("model-2", { teamId: "team", versionHash: "c".repeat(64) });
});
