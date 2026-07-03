import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "bun:test";
import { loadWorkspaceStateAtPath } from "../apps/server/src/workspace/workspace-state";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace state", () => {
  test("compares local HEAD against the linked cloud source commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openpond-workspace-state-"));
    tempRoots.push(root);
    await git(root, "init");
    await git(root, "checkout", "-B", "main");
    await git(root, "config", "user.name", "OpenPond Test");
    await git(root, "config", "user.email", "test@openpond.ai");
    await writeFile(join(root, "README.md"), "# First\n", "utf8");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "first");
    const linkedCommit = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "README.md"), "# Second\n", "utf8");
    await git(root, "commit", "-am", "second");
    const headCommit = await git(root, "rev-parse", "HEAD");

    const state = await loadWorkspaceStateAtPath(
      { workspacePath: root, repoPath: root },
      {
        id: "local_project_1",
        gitOwner: null,
        gitRepo: null,
        gitHost: null,
        defaultBranch: "main",
      },
      { linkedSourceHeadCommit: linkedCommit },
    );

    expect(state.headCommit).toBe(headCommit);
    expect(state.linkedSourceHeadCommit).toBe(linkedCommit);
    expect(state.aheadOfLinkedSource).toBe(1);
    expect(state.behindLinkedSource).toBe(0);
    expect(state.divergedFromLinkedSource).toBe(false);
    expect(state.linkedSourceComparisonError).toBeNull();
  });
});

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root });
  return result.stdout.trim();
}
