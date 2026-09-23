import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";
import { SqliteStore } from "./store.js";

test("existing v65 stores gain Profile evaluation tables on startup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-profile-migration-"));
  let store = new SqliteStore(directory);
  try {
    await store.listProfileEvaluationSuiteRuns({
      source: "openpond_git", repositoryId: "repo", profileId: "default",
    });
    await store.close();

    const db = new DatabaseSync(path.join(directory, "state", "state.sqlite"));
    try {
      db.exec("DROP TABLE profile_evaluation_suite_runs");
      db.exec("DROP TABLE profile_evaluation_comparisons");
      db.exec("PRAGMA user_version = 65");
    } finally {
      db.close();
    }

    store = new SqliteStore(directory);
    await expect(store.listProfileEvaluationSuiteRuns({
      source: "openpond_git", repositoryId: "repo", profileId: "default",
    })).resolves.toEqual([]);
    await expect(store.listProfileEvaluationComparisons({
      source: "openpond_git", repositoryId: "repo", profileId: "default",
    })).resolves.toEqual([]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
