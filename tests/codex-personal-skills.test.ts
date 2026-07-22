import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  loadCodexPersonalSkills,
  readCodexPersonalSkillFile,
} from "../apps/server/src/codex-personal-skills";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex personal skill packages", () => {
  test("discovers package resources and reads text and binary previews", async () => {
    const skillsRoot = await createSkillPackage();

    const skills = await loadCodexPersonalSkills(skillsRoot);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "demo-skill",
      validationStatus: "valid",
      resourceFiles: ["assets/logo.png", "scripts/render.py"],
    });

    await expect(readCodexPersonalSkillFile("demo-skill", "scripts/render.py", skillsRoot))
      .resolves.toMatchObject({
        scope: "codex",
        path: "scripts/render.py",
        isBinary: false,
        content: "print('hello')\n",
      });
    await expect(readCodexPersonalSkillFile("demo-skill", "assets/logo.png", skillsRoot))
      .resolves.toMatchObject({
        isBinary: true,
        content: null,
      });
  });

  test("rejects traversal and symlink escapes", async () => {
    const skillsRoot = await createSkillPackage();
    const outsideFile = path.join(path.dirname(skillsRoot), "outside.txt");
    await writeFile(outsideFile, "private\n");
    await symlink(outsideFile, path.join(skillsRoot, "demo-skill", "linked.txt"));

    await expect(readCodexPersonalSkillFile("demo-skill", "../outside.txt", skillsRoot))
      .rejects.toThrow("Invalid skill source path");
    await expect(readCodexPersonalSkillFile("demo-skill", "linked.txt", skillsRoot))
      .rejects.toThrow("escapes its package");
  });
});

async function createSkillPackage(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-skill-source-"));
  tempRoots.push(root);
  const skillsRoot = path.join(root, "skills");
  const packageRoot = path.join(skillsRoot, "demo-skill");
  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await mkdir(path.join(packageRoot, "assets"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Use for deterministic demo rendering.\n---\n\n# Demo\n",
  );
  await writeFile(path.join(packageRoot, "scripts", "render.py"), "print('hello')\n");
  await writeFile(path.join(packageRoot, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  return skillsRoot;
}
