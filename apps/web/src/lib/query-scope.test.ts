import { expect, it, vi } from "vitest";
import { createWorkspaceQueryClient } from "./query-client";
import { connectionQueryScope, learningQueryScope, scopeLearningClient } from "./query-scope";

// A remounted page should reuse its request; another profile or changed credential
// must never receive that cached response, including during mutation invalidation.
it("deduplicates scoped reads, reuses warm data and isolates credential/profile changes", async () => {
  const queries = createWorkspaceQueryClient();
  const connection = { serverUrl: "https://local.invalid", token: "test-original-credential" };
  const scope = connectionQueryScope(connection);
  const first = scopeLearningClient({}, ["learning", scope, "profile-a"]);
  const remounted = scopeLearningClient({}, ["learning", connectionQueryScope(connection), "profile-a"]);
  const otherProfile = scopeLearningClient({}, ["learning", scope, "profile-b"]);
  const queryKey = [...learningQueryScope(first), "resource", "source", "same-id"];
  let complete!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
  const firstRead = queries.fetchQuery({ queryKey, queryFn: read });
  const secondRead = queries.fetchQuery({ queryKey: [...learningQueryScope(remounted), "resource", "source", "same-id"], queryFn: read });
  expect(read).toHaveBeenCalledTimes(1);
  complete("profile-a-value");
  expect(await Promise.all([firstRead, secondRead])).toEqual(["profile-a-value", "profile-a-value"]);
  expect(await queries.fetchQuery({ queryKey, queryFn: read })).toBe("profile-a-value");
  expect(read).toHaveBeenCalledTimes(1);
  const otherKey = [...learningQueryScope(otherProfile), "resource", "source", "same-id"];
  expect(queries.getQueryData(otherKey)).toBeUndefined();
  queries.setQueryData(otherKey, "profile-b-value");
  await queries.invalidateQueries({ queryKey: learningQueryScope(first), refetchType: "none" });
  expect(queries.getQueryState(queryKey)?.isInvalidated).toBe(true);
  expect(queries.getQueryState(otherKey)?.isInvalidated).toBe(false);
  connection.token = "test-replacement-credential";
  const replaced = connectionQueryScope(connection);
  expect(replaced).not.toBe(scope);
  expect(queries.getQueryData(["learning", replaced, "profile-a", "resource", "source", "same-id"])).toBeUndefined();
  expect(JSON.stringify(queries.getQueryCache().getAll().map(query => query.queryKey))).not.toContain("credential");
  queries.clear();
});
