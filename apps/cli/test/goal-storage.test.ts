import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  goalStateDisplayPath,
  parseGoalStorageLocation,
  resolveGoalStorageRoot,
} from "../src/goal/config";

describe("goal storage", () => {
  test("defaults global storage to ~/.openpond display paths", () => {
    const storageRoot = resolveGoalStorageRoot({ location: "global" });
    expect(storageRoot).toBe(os.homedir());
    expect(
      goalStateDisplayPath({
        storageRoot,
        goalId: "goal_1",
        fileName: "state.json",
      }),
    ).toBe("~/.openpond/goals/goal_1/state.json");
  });

  test("can route storage to the working directory", async () => {
    const workspace = await mkdtemp(join(os.tmpdir(), "openpond-goal-storage-"));
    try {
      expect(resolveGoalStorageRoot({ cwd: workspace, location: "workspace" })).toBe(workspace);
      expect(parseGoalStorageLocation("working-directory")).toBe("workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
