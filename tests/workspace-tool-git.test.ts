import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureWorkspaceGitRepository,
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
} from "../apps/server/src/workspace-tools/workspace-tool-git";
import { runTestProcess } from "./helpers/run-process";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "openpond-git-tools-"));
}

async function git(cwd: string, args: string[]): Promise<void> {
  const { exitCode, stdout, stderr } = await runTestProcess("git", args, {
    cwd,
  });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
}

describe("workspace git tools", () => {
  test("throws useful errors for non-git workspaces", async () => {
    const repoPath = await tempWorkspace();

    await expect(getWorkspaceGitStatus(repoPath)).rejects.toThrow(/git status failed|not a git repository/i);
    await expect(getWorkspaceGitDiff(repoPath)).rejects.toThrow(/git diff failed|not a git repository/i);
  });

  test("reports dirty files and separates staged and working-tree diffs", async () => {
    const repoPath = await tempWorkspace();
    await ensureWorkspaceGitRepository(repoPath, "main");
    await git(repoPath, ["config", "user.email", "openpond-app@example.local"]);
    await git(repoPath, ["config", "user.name", "OpenPond App"]);
    await writeFile(path.join(repoPath, "tracked.txt"), "initial\n");
    await git(repoPath, ["add", "tracked.txt"]);
    await git(repoPath, ["commit", "-m", "Initial commit"]);

    await writeFile(path.join(repoPath, "tracked.txt"), "initial\nunstaged\n");
    await writeFile(path.join(repoPath, "staged.txt"), "staged\n");
    await git(repoPath, ["add", "staged.txt"]);

    const status = await getWorkspaceGitStatus(repoPath);
    const workingTreeDiff = await getWorkspaceGitDiff(repoPath);
    const stagedDiff = await getWorkspaceGitDiff(repoPath, { staged: true });

    expect(status.dirty).toBe(true);
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", status: "M" }),
        expect.objectContaining({ path: "staged.txt", status: "A" }),
      ]),
    );
    expect(workingTreeDiff).toMatchObject({ staged: false });
    expect(workingTreeDiff.diff).toContain("+unstaged");
    expect(stagedDiff).toMatchObject({ staged: true });
    expect(stagedDiff.diff).toContain("staged.txt");
  });
});
