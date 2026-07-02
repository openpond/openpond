import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import {
  PROJECT_SOURCE_UPLOAD_LIMITS,
  PROJECT_SOURCE_UPLOAD_TRANSPORT,
  collectProjectSourceUploadEntries,
} from "../apps/cli/src/cli/project-agent";
import {
  PROFILE_SOURCE_UPLOAD_LIMITS,
  PROFILE_SOURCE_UPLOAD_TRANSPORT,
  collectProfileSourceUploadEntries,
} from "../packages/cloud/src/profile/profile-source-upload";
import { SOURCE_UPLOAD_CACHE_PATH } from "../packages/cloud/src/profile/source-upload-cache";

describe("profile source upload", () => {
  test("excludes local goal state from promoted profile source", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "openpond-profile-upload-"));
    await mkdir(join(repoPath, "profiles", "default", "agent"), { recursive: true });
    await mkdir(join(repoPath, "profiles", "default", ".openpond", "goals", "goal_1"), {
      recursive: true,
    });
    await writeFile(join(repoPath, "openpond-profile.json"), "{}\n", "utf8");
    await writeFile(join(repoPath, "profiles", "default", "agent", "agent.ts"), "export {};\n", "utf8");
    await writeFile(
      join(repoPath, "profiles", "default", ".openpond", "goals", "goal_1", "state.json"),
      '{"status":"awaiting_approval"}\n',
      "utf8",
    );
    git(repoPath, "init", "-b", "main");
    git(repoPath, "add", "-A");

    const upload = await collectProfileSourceUploadEntries(repoPath);
    const paths = upload.entries.map((entry) => entry.path);

    expect(paths).toContain("openpond-profile.json");
    expect(paths).toContain("profiles/default/agent/agent.ts");
    expect(paths).not.toContain("profiles/default/.openpond/goals/goal_1/state.json");
    expect(upload.limits).toEqual(PROFILE_SOURCE_UPLOAD_LIMITS);
    expect(upload.transport).toEqual(PROFILE_SOURCE_UPLOAD_TRANSPORT);
  });

  test("profile upload preserves sorted entries and byte totals while skipping env files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "openpond-profile-upload-order-"));
    await mkdir(join(repoPath, "profiles", "default", "agent"), { recursive: true });
    await writeFile(join(repoPath, "profiles", "default", "agent", "z.ts"), "zeta\n", "utf8");
    await writeFile(join(repoPath, "profiles", "default", "agent", "a.ts"), "alpha\n", "utf8");
    await writeFile(join(repoPath, ".env"), "SECRET=should-not-upload\n", "utf8");
    git(repoPath, "init", "-b", "main");
    git(repoPath, "add", "-A");

    const upload = await collectProfileSourceUploadEntries(repoPath);

    expect(upload.entries.map((entry) => entry.path)).toEqual([
      "profiles/default/agent/a.ts",
      "profiles/default/agent/z.ts",
    ]);
    expect(upload.totalBytes).toBe(Buffer.byteLength("alpha\nzeta\n"));
    expect(
      Buffer.from(upload.entries[0]!.contentsBase64, "base64").toString("utf8")
    ).toBe("alpha\n");
  });

  test("profile upload reuses unchanged cached file contents without rereading", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "openpond-profile-upload-cache-"));
    const sourcePath = join(repoPath, "profiles", "default", "agent", "agent.ts");
    await mkdir(join(repoPath, "profiles", "default", "agent"), { recursive: true });
    await writeFile(sourcePath, "export const cached = true;\n", "utf8");
    git(repoPath, "init", "-b", "main");
    git(repoPath, "add", "-A");

    const firstUpload = await collectProfileSourceUploadEntries(repoPath);
    expect(firstUpload.entries.map((entry) => entry.path)).toEqual([
      "profiles/default/agent/agent.ts",
    ]);

    await chmod(sourcePath, 0o000);
    const secondUpload = await collectProfileSourceUploadEntries(repoPath);

    expect(secondUpload.entries).toEqual(firstUpload.entries);
    expect(secondUpload.totalBytes).toBe(firstUpload.totalBytes);
    expect(secondUpload.entries.map((entry) => entry.path)).not.toContain(SOURCE_UPLOAD_CACHE_PATH);
  });

  test("project upload uses filesystem fallback with sorted entries and explicit byte totals", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "openpond-project-upload-"));
    await mkdir(join(projectPath, "src"), { recursive: true });
    await mkdir(join(projectPath, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(projectPath, "src", "b.ts"), "bravo\n", "utf8");
    await writeFile(join(projectPath, "src", "a.ts"), "alpha\n", "utf8");
    await writeFile(join(projectPath, ".env.local"), "SECRET=ignored\n", "utf8");
    await writeFile(join(projectPath, "node_modules", "ignored", "x.js"), "ignored\n", "utf8");

    const upload = await collectProjectSourceUploadEntries(projectPath);

    expect(upload.entries.map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(upload.fileCount).toBe(2);
    expect(upload.totalBytes).toBe(Buffer.byteLength("alpha\nbravo\n"));
    expect(upload.limits).toEqual(PROJECT_SOURCE_UPLOAD_LIMITS);
    expect(upload.transport).toEqual(PROJECT_SOURCE_UPLOAD_TRANSPORT);
    expect(
      Buffer.from(upload.entries[1]!.contentsBase64, "base64").toString("utf8")
    ).toBe("bravo\n");
  });

  test("project upload reuses unchanged cached file contents without rereading", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "openpond-project-upload-cache-"));
    const sourcePath = join(projectPath, "src", "cached.ts");
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(sourcePath, "export const cached = true;\n", "utf8");

    const firstUpload = await collectProjectSourceUploadEntries(projectPath);
    expect(firstUpload.entries.map((entry) => entry.path)).toEqual(["src/cached.ts"]);

    await chmod(sourcePath, 0o000);
    const secondUpload = await collectProjectSourceUploadEntries(projectPath);

    expect(secondUpload.entries).toEqual(firstUpload.entries);
    expect(secondUpload.totalBytes).toBe(firstUpload.totalBytes);
    expect(secondUpload.entries.map((entry) => entry.path)).not.toContain(SOURCE_UPLOAD_CACHE_PATH);
  });
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
}
