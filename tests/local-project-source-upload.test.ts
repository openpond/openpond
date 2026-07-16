import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { LocalProject } from "@openpond/contracts";
import {
  collectLocalProjectSourceUploadBundle,
  previewLocalProjectSourceUpload,
} from "../apps/server/src/workspace/local-project-source-upload";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local project source upload", () => {
  test("skips generated OpenPond upload cache files", async () => {
    const root = await mkdtemp(join(tmpdir(), "openpond-local-project-upload-"));
    tempRoots.push(root);
    await mkdir(join(root, ".openpond"), { recursive: true });
    await mkdir(join(root, ".openpond", "skills", "release-notes"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(root, ".openpond", "source-upload-cache.json"), "{}", "utf8");
    await writeFile(
      join(root, ".openpond", "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Write release notes.\n---\n\nUse concise bullets.\n",
      "utf8",
    );

    const bundle = await collectLocalProjectSourceUploadBundle(localProject(root));

    expect(bundle.entries.map((entry) => entry.path).sort()).toEqual([
      ".openpond/skills/release-notes/SKILL.md",
      "README.md",
      "src/index.ts",
    ]);
    expect(bundle.skipped).toEqual([]);
  });

  test("previews the same selected source files without reading bundle contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "openpond-local-project-preview-"));
    tempRoots.push(root);
    await mkdir(join(root, ".openpond"), { recursive: true });
    await mkdir(join(root, ".openpond", "skills", "release-notes"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(root, ".openpond", "source-upload-cache.json"), "{}", "utf8");
    await writeFile(
      join(root, ".openpond", "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Write release notes.\n---\n\nUse concise bullets.\n",
      "utf8",
    );

    const preview = await previewLocalProjectSourceUpload(localProject(root));

    expect(preview.fileCount).toBe(3);
    expect(preview.headCommit).toBeNull();
    expect(preview.byteCount).toBe(Buffer.byteLength(
      "---\nname: release-notes\ndescription: Write release notes.\n---\n\nUse concise bullets.\n# Fixture\nexport const ok = true;\n",
      "utf8",
    ));
    expect(preview.skippedCount).toBe(0);
    expect(preview.initializedEmptyProject).toBe(false);
    expect(preview.skipped).toEqual([]);
  });
});

function localProject(root: string): LocalProject {
  const now = new Date("2026-07-03T00:00:00.000Z").toISOString();
  return {
    id: "local_test",
    name: "Local Test",
    path: root,
    workspacePath: root,
    repoPath: null,
    source: "folder",
    systemKind: null,
    hiddenFromDefaultSidebar: false,
    sandboxTemplate: null,
    agentSdk: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: now,
    updatedAt: now,
  };
}
