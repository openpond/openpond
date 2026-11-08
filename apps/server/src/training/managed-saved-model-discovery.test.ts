import { expect, test, vi } from "vitest";
import type { SqliteStore } from "../store/store.js";
const mocks = vi.hoisted(() => ({ fence: vi.fn(async (_access: unknown) => {}), read: vi.fn(async (_id: string) => ({ version: null })), catalog: vi.fn(async () => ({ projects: Array.from({ length: 12 }, (_, i) => ({ project: { id: `model-${i}` } })) })) }));
vi.mock("./managed-saved-model-access.js", () => ({ accountFence: mocks.fence, clientFor: () => ({ modelVersion: mocks.read }) }));
vi.mock("./hosted-model-project-catalog.js", () => ({ listHostedModelProjectCatalog: mocks.catalog }));
import { listManagedSavedModelVersions } from "./managed-saved-model-discovery.js";

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
