import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  commitProfileBenchmarkRef,
  runGitCommand,
} from "@openpond/cloud/profile/profile-git";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Profile benchmark Git persistence", () => {
  it("creates an isolated result ref without touching the branch, index, or worktree", async () => {
    const repoPath = await mkdtemp(path.join(os.tmpdir(), "openpond-benchmark-git-"));
    temporaryDirectories.push(repoPath);
    await git(repoPath, ["init", "-b", "main"]);
    await writeFile(path.join(repoPath, "profile.yaml"), "name: Personal\n", "utf8");
    await git(repoPath, ["add", "profile.yaml"]);
    await git(repoPath, ["commit", "-m", "Initial Profile"]);
    const baseCommit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "notes.txt"), "unrelated work\n", "utf8");
    const statusBefore = await git(repoPath, ["status", "--porcelain=v1", "-uall"]);

    const receipt = await commitProfileBenchmarkRef({
      repoPath,
      runId: "model_run_123",
      baseCommit,
      files: [
        {
          path: "benchmarks/harness-refiner/runs/model_run_123/result.json",
          contents: "{\"result\":\"improved\"}\n",
        },
        {
          path: "benchmarks/harness-refiner/runs/model_run_123/candidate-harness/harness.json",
          contents: "{}\n",
        },
      ],
    });

    expect(receipt.ref).toBe("refs/openpond/benchmarks/model_run_123");
    expect(await git(repoPath, ["rev-parse", "HEAD"])).toBe(`${baseCommit}\n`);
    expect(await git(repoPath, ["status", "--porcelain=v1", "-uall"])).toBe(statusBefore);
    expect(
      await git(repoPath, [
        "show",
        `${receipt.ref}:benchmarks/harness-refiner/runs/model_run_123/result.json`,
      ]),
    ).toBe("{\"result\":\"improved\"}\n");
    expect(await readFile(path.join(repoPath, "notes.txt"), "utf8"))
      .toBe("unrelated work\n");
  });
});

async function git(repoPath: string, args: string[]) {
  const result = await runGitCommand(repoPath, args, {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenPond Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "OpenPond Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
