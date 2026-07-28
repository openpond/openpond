import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUNDLED_AUTHORING_SKILL_NAMES,
  loadBundledAuthoringSkillBundle,
  loadBundledAuthoringSkills,
  readBundledAuthoringProfileSkill,
  resolveBundledAuthoringSkillRoot,
} from "../apps/server/src/runtime/bundled-authoring-skills";

describe("bundled OpenPond authoring skills", () => {
  test("loads both complete SKILL.md packages with stable metadata", async () => {
    const skills = await loadBundledAuthoringSkills();

    expect(skills.map((skill) => skill.name)).toEqual(BUNDLED_AUTHORING_SKILL_NAMES);
    for (const skill of skills) {
      expect(skill.enabled).toBe(true);
      expect(skill.validationStatus).toBe("valid");
      expect(skill.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(skill.charCount).toBeGreaterThan(1_000);
      await expect(access(path.join(skill.sourcePath, "SKILL.md"))).resolves.toBeUndefined();
      await expect(access(path.join(skill.sourcePath, "agents", "openai.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  test("includes focused references and exposes the Skill validator as a package resource", async () => {
    const skill = await readBundledAuthoringProfileSkill("openpond-skill-authoring");
    const agent = await readBundledAuthoringProfileSkill("openpond-agent-authoring");

    expect(skill.body).toContain("# OpenPond Skill Authoring");
    expect(skill.body).toContain("## Bundled reference: references/copying-and-adaptation.md");
    expect(skill.resourceFiles).toContain("scripts/validate-skill.mjs");
    expect(agent.body).toContain("# OpenPond Agent Authoring");
    expect(agent.body).toContain("## Bundled reference: references/action-and-chat-design.md");
    expect(agent.resourceFiles).not.toContain("agents/openai.yaml");
  });

  test("resolves the staged dist/skills layout without a source checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-authoring-skill-stage-"));
    try {
      const packageRoot = path.join(root, "dist", "skills", "openpond-skill-authoring");
      await mkdir(path.join(packageRoot, "references"), { recursive: true });
      await Promise.all([
        writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: openpond-skill-authoring\ndescription: Staged authoring fixture used by the loader test.\n---\n"),
        writeFile(path.join(packageRoot, "references", "skill-package-layout.md"), "layout\n"),
        writeFile(path.join(packageRoot, "references", "copying-and-adaptation.md"), "copy\n"),
        writeFile(path.join(packageRoot, "references", "validation-and-repair.md"), "validate\n"),
      ]);

      expect(await resolveBundledAuthoringSkillRoot("openpond-skill-authoring", root))
        .toBe(packageRoot);
      expect(await loadBundledAuthoringSkillBundle("openpond-skill-authoring", root))
        .toContain("## Bundled reference: references/validation-and-repair.md");
      await expect(readFile(path.join(packageRoot, "agents", "openai.yaml"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
