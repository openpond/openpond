import { describe, expect, test } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadTasksetAuthoringSkillBundle,
  loadTasksetAuthoringProfileSkill,
  readTasksetAuthoringProfileSkill,
  resolveTasksetAuthoringSkillRoot,
} from "../apps/server/src/training/task-authoring-skill";

describe("bundled Taskset Authoring skill", () => {
  test("ships one progressive skill with focused references", async () => {
    const root = "apps/cli/skills/openpond-taskset-authoring";
    const skill = await readFile(`${root}/SKILL.md`, "utf8");
    const refs = await readdir(`${root}/references`);
    expect(skill).toContain("The user should only");
    expect(skill).toContain("one plain-language question at a time");
    expect(skill).toContain("Do not ask the user to provide internal names");
    expect(skill).toContain("The dataset is the task collection or source data inside that package");
    expect(skill).toContain("submitting the first rollout or");
    expect(skill).toContain("Treat fixed synthetic smoke fixtures as diagnostics");
    expect(refs.toSorted()).toEqual(["graders-and-rewards.md", "method-selection.md", "privacy-and-provenance.md", "task-design.md"]);
    expect((await readdir("apps/cli/skills")).filter((name) => name.includes("taskset") || name.includes("task-miner"))).toEqual(["openpond-taskset-authoring"]);
  });

  test("bundles focused references for provider-backed authoring", async () => {
    const bundle = await loadTasksetAuthoringSkillBundle();
    for (const name of ["task-design.md", "graders-and-rewards.md", "method-selection.md", "privacy-and-provenance.md"]) {
      expect(bundle).toContain(`Bundled reference: ${name}`);
    }
    expect(bundle).toContain("Prefer deterministic graders");
  });

  test("publishes Taskset Authoring as a valid built-in Chat skill", async () => {
    const metadata = await loadTasksetAuthoringProfileSkill();
    const loaded = await readTasksetAuthoringProfileSkill();
    expect(metadata).toMatchObject({
      name: "openpond-taskset-authoring",
      enabled: true,
      validationStatus: "valid",
    });
    expect(metadata.description).toContain("OpenPond Taskset");
    expect(metadata.sourceHash).toHaveLength(64);
    expect(loaded.body).toContain("installed Dataset Builder actions");
    expect(loaded.body).toContain("Do not recite those schemas");
    expect(loaded.resourceFiles).toContain("references/method-selection.md");
  });

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
