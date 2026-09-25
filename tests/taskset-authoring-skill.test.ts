import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadTasksetAuthoringSkillBundle,
  resolveTasksetAuthoringSkillRoot
} from "../apps/server/src/training/task-authoring-skill";

describe("bundled Taskset Authoring skill", () => {

  test("loads the skill from an installed CLI distribution", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-installed-skill-"));
    try {
      await cp(
        "apps/cli/skills/openpond-taskset-authoring",
        path.join(packageRoot, "dist", "skills", "openpond-taskset-authoring"),
        { recursive: true },
      );
      const bundle = await loadTasksetAuthoringSkillBundle(packageRoot);
      expect(bundle).toContain("OpenPond Taskset Authoring");
      expect(bundle).toContain("Bundled reference: task-design.md");
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  test("resolves the skill beside a compiled CLI executable", async () => {
    const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "openpond-compiled-skill-"));
    try {
      const skillRoot = path.join(releaseRoot, "skills", "openpond-taskset-authoring");
      await cp("apps/cli/skills/openpond-taskset-authoring", skillRoot, { recursive: true });
      expect(
        await resolveTasksetAuthoringSkillRoot(
          path.join(releaseRoot, "unrelated-cwd"),
          path.join(releaseRoot, "openpond"),
        ),
      ).toBe(skillRoot);
    } finally {
      await rm(releaseRoot, { recursive: true, force: true });
    }
  });
});
