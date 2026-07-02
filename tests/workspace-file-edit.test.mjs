import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { editWorkspaceFile } from "../apps/server/dist/workspace-tools/workspace-tool-file-system.js";
import { previewWorkspaceEditFile } from "../apps/server/dist/workspace-tools/workspace-tool-preview.js";

describe("workspace file edits", () => {
  test("rejects ambiguous edit text unless replaceAll is explicit", async () => {
    const repoPath = await mkdtemp(path.join(os.tmpdir(), "openpond-edit-guard-"));
    const targetPath = path.join(repoPath, "README.md");
    await writeFile(targetPath, "# One\n\n# Two\n", "utf8");

    try {
      await assert.rejects(
        () => previewWorkspaceEditFile(repoPath, "README.md", "# ", "## "),
        /Text matched 2 times/
      );
      await assert.rejects(
        () => editWorkspaceFile(repoPath, "README.md", "# ", "## "),
        /Text matched 2 times/
      );

      const edited = await editWorkspaceFile(repoPath, "README.md", "# ", "## ", {
        replaceAll: true,
      });

      assert.equal(edited.replacements, 2);
      assert.equal(await readFile(targetPath, "utf8"), "## One\n\n## Two\n");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
