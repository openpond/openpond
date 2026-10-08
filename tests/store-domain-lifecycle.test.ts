import { expect, test } from "vitest";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { lazyStoreDomain, StoreDomainLifecycle } from "../apps/server/src/store/store-domain-loader.js";
import { withTempDirectory } from "./helpers/temp-directory.js";

// Closing during a first import must drain admitted calls, initialize once,
// and reject new work before the database owner releases its connection.
test("drains concurrent first-use domain calls before shutdown", async () => {
  const lifecycle = new StoreDomainLifecycle();
  const gate = Promise.withResolvers<void>();
  let loads = 0;
  const domain = lazyStoreDomain(lifecycle, async () => {
    loads++;
    await gate.promise;
    return { async read(value: number): Promise<number> {
      // This repository-style nested read retains the already-admitted call.
      return lifecycle.run(async () => value);
    } };
  });
  const methods = domain.methods(["read"]);
  expect(loads).toBe(0);
  const first = methods.read(1);
  const second = methods.read(2);
  const closed = lifecycle.close();
  await expect(methods.read(3)).rejects.toThrow("closing");
  let drained = false;
  void closed.then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  gate.resolve();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  await closed;
  expect(loads).toBe(1);
});

// Independently loaded domains must share the transaction queue. Otherwise a
// failed learning transaction can roll back an unrelated feature's write.
test("serializes independent domains and preserves their writes across rollback and close", async () => {
  await withTempDirectory("openpond-domain-queue-", async home => {
    const store = new SqliteStore(home);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = store.learningRepository().transaction("scope", async () => {
      entered.resolve();
      await release.promise;
      throw new Error("rollback fixture");
    });
    const rejected = expect(transaction).rejects.toThrow("rollback fixture");
    await entered.promise;
    let persisted = false;
    const write = store.patchSidebarFileBookmark("scope", {
      workspaceKind: "local", workspaceId: "workspace", workspaceName: "Workspace",
      path: "example.txt", status: "pinned",
    }).then(value => { persisted = true; return value; });
    const closed = store.close();
    await expect(store.listSidebarFileBookmarks("scope")).rejects.toThrow("closing");
    expect(persisted).toBe(false);
    release.resolve();
    await rejected;
    expect(await write).toMatchObject({ status: "pinned" });
    await closed;
    const reopened = new SqliteStore(home);
    try {
      expect(await reopened.listSidebarFileBookmarks("scope")).toMatchObject([{ path: "example.txt", status: "pinned" }]);
    } finally { await reopened.close(); }
  });
});
