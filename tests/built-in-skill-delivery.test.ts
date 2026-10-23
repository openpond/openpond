import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { BUILT_IN_OPENPOND_PROFILE_SKILLS } from "@openpond/contracts";
import { loadBuiltInSkillCatalog } from "../apps/server/src/runtime/built-in-skill-catalog";

// A packaged app must report the files it actually ships as ready, and a missing
// reference must make only that skill unavailable instead of hiding every skill.
test("installed built-in catalog verifies all five delivered skill packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-built-in-skills-"));
  try {
    await Promise.all(
      BUILT_IN_OPENPOND_PROFILE_SKILLS.map((skill) =>
        cp(
          path.resolve("apps/cli/skills", skill.name),
          path.join(root, "dist/skills", skill.name),
          { recursive: true },
        ),
      ),
    );
    const catalog = await loadBuiltInSkillCatalog(root);
    expect(catalog).toHaveLength(5);
    for (const skill of catalog) {
      expect(skill.validationStatus).toBe("valid");
      expect(skill.enabled).toBe(true);
      expect(skill.path.startsWith(root)).toBe(true);
      expect(skill.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(skill.charCount).toBeGreaterThan(0);
    }
    await rm(path.join(root, "dist/skills/openpond-cli/references/experiments-and-training.md"));
    const damaged = await loadBuiltInSkillCatalog(root);
    expect(damaged.find((skill) => skill.name === "openpond-cli")).toMatchObject({
      enabled: false,
      validationStatus: "error",
    });
    expect(damaged.filter((skill) => skill.validationStatus === "valid")).toHaveLength(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
