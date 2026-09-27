import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { listLocalProjects, upsertLocalProject } from "../apps/server/src/workspace/local-projects.js";

// A collection must survive reload with its primary and stable ID; rejected roots must not leave a partial record.
test("local project collection saves atomically and keeps its identity", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-project-collection-"));
  const first = path.join(home, "first");
  const second = path.join(home, "second");
  const alias = path.join(home, "alias");
  await mkdir(first);
  await mkdir(second);
  await symlink(first, alias);
  let store = new SqliteStore(home);
  try {
    const request = {
      name: "Research",
      sourceFolders: [first, second],
      primaryFolder: second,
    };
    const [created, concurrent] = await Promise.all([
      upsertLocalProject(store, request),
      upsertLocalProject(store, request),
    ]);
    expect(created.created).toBe(true);
    expect(concurrent.project.id).toBe(created.project.id);
    expect(created.project.workspacePath).toBe(second);
    expect(created.project.sourceFolders).toEqual([first, second]);
    await store.close();
    store = new SqliteStore(home);
    const [reloaded] = await listLocalProjects(store);
    expect(reloaded?.id).toBe(created.project.id);
    expect(reloaded?.sourceFolders).toEqual([first, second]);
    expect(reloaded?.workspacePath).toBe(second);

    const reopened = await upsertLocalProject(store, { name: "Research", sourceFolders: [second, first], primaryFolder: first });
    expect(reopened).toMatchObject({ created: false, project: { id: created.project.id, workspacePath: second } });
    await expect(upsertLocalProject(store, { name: "Invalid", sourceFolders: [first, alias], primaryFolder: first })).rejects.toThrow("more than once");
    await expect(upsertLocalProject(store, { name: "Invalid", sourceFolders: [first, second], primaryFolder: home })).rejects.toThrow("Primary folder");
    await expect(upsertLocalProject(store, { name: "Invalid", sourceFolders: [first, path.join(home, "missing")], primaryFolder: first })).rejects.toThrow("not found");
    await expect(upsertLocalProject(store, { name: "Invalid", createNew: true, baseDirectory: home, sourceFolders: [first] })).rejects.toThrow("cannot be combined");
    expect((await listLocalProjects(store)).map((project) => project.id)).toEqual([created.project.id]);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
