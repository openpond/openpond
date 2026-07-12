import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { loadTasksetAuthoringSkillBundle } from "../apps/server/src/training/task-authoring-skill";

describe("bundled Taskset Authoring skill", () => {
  test("ships one progressive skill with focused references", async () => {
    const root = "apps/cli/skills/openpond-taskset-authoring";
    const skill = await readFile(`${root}/SKILL.md`, "utf8");
    const refs = await readdir(`${root}/references`);
    expect(skill).toContain("Create with defaults");
    expect(skill).toContain("positive/negative/boundary/adversarial");
    expect(skill).toContain("Keep the user-facing name and objective natural");
    expect(skill).toContain("Treat synthetic smoke fixtures as diagnostics");
    expect(skill).toContain("Never put source IDs, hashes, cluster keys");
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
});
