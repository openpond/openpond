import { describe, expect, it } from "vitest";
import { ModelStarterCatalogPageSchema } from "openpond-sdk/model-starter-catalog";
import { readModelStarterCache, writeModelStarterCache } from "./model-starter-cache";

describe("persisted starter catalog boundary", () => {
  // Restarted clients must retain metadata without crossing workspace/cursor
  // boundaries or accepting private package fields as a catalog projection.
  it("restores validated metadata for only its original scope and page", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const page = ModelStarterCatalogPageSchema.parse({ items: [], nextCursor: "next" });
    writeModelStarterCache(storage, "staging/team-a/account-a", undefined, page);
    expect(readModelStarterCache(storage, "staging/team-a/account-a")).toEqual(page);
    expect(readModelStarterCache(storage, "production/team-a/account-a")).toBeNull();
    expect(readModelStarterCache(storage, "staging/team-b/account-a")).toBeNull();
    expect(readModelStarterCache(storage, "staging/team-a/account-b")).toBeNull();
    expect(readModelStarterCache(storage, "staging/team-a/account-a", "next")).toBeNull();
    const key = [...values.keys()][0]!;
    values.set(key, JSON.stringify({ ...page, taskset: { tasks: [{ expectedOutput: "private" }] } }));
    expect(readModelStarterCache(storage, "staging/team-a/account-a")).toBeNull();
    values.set(key, "not-json");
    expect(readModelStarterCache(storage, "staging/team-a/account-a")).toBeNull();
    values.set(key, " ".repeat(1_000_001));
    expect(readModelStarterCache(storage, "staging/team-a/account-a")).toBeNull();
    expect(() => writeModelStarterCache({ setItem: () => { throw new Error("quota"); } }, "scope", undefined, page)).not.toThrow();
  });
});
