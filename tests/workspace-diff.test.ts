import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "bun:test";
import { AppPreferencesSchema, localPathWorkspaceId, type BootstrapPayload, type WorkspaceDiffSummary } from "@openpond/contracts";
import {
  clearWorkspaceDiffCacheForTests,
  loadWorkspaceDiffAtPath,
  loadWorkspaceFileAtPath,
  loadWorkspaceImageFileAtPath,
  mapWorkspaceDiffEntriesWithConcurrency,
} from "../apps/server/src/workspace/workspace-diff";
import { readLocalImageFile } from "../apps/server/src/workspace/workspace-common";
import { workspaceDiffSinceBaseline } from "../apps/server/src/workspace/server-workspace-session-workflows";
import { createServerWorkspacePayloads } from "../apps/server/src/workspace/server-workspace-payloads";
import { SqliteStore } from "../apps/server/src/store/store";
import { buildFileTree } from "../apps/web/src/components/workspace-diff/workspace-diff-summary-model";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  clearWorkspaceDiffCacheForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function resolveGitBinary(): Promise<string> {
  const result = await execFileAsync("bash", ["-lc", "command -v git"]);
  return String(result.stdout).trim();
}

async function installGitTraceWrapper(wrapperDir: string): Promise<{ logPath: string; wrapperPath: string }> {
  const wrapperPath = path.join(wrapperDir, "git");
  const logPath = path.join(wrapperDir, "git-args.log");
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "if [[ -n \"${OPENPOND_GIT_TRACE_ARGS:-}\" ]]; then",
      "  {",
      "    printf '%s' \"$PWD\"",
      "    for arg in \"$@\"; do printf '\\t%s' \"$arg\"; done",
      "    printf '\\n'",
      "  } >> \"$OPENPOND_GIT_TRACE_ARGS\"",
      "fi",
      "exec \"$OPENPOND_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  return { logPath, wrapperPath };
}

type GitTraceCommand = {
  cwd: string;
  args: string[];
};

function parseGitTraceLine(line: string): GitTraceCommand | null {
  if (!line) return null;
  const [cwd, ...args] = line.split("\t");
  return cwd ? { cwd, args } : null;
}

function diffSummary(files: WorkspaceDiffSummary["files"]): WorkspaceDiffSummary {
  return {
    appId: "workspace-test",
    repoPath: "/tmp/workspace-test",
    initialized: true,
    dirty: files.length > 0,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    repoFiles: files.map((file) => file.path),
    files,
    error: null,
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

describe("workspace diff", () => {
  test("limits per-file diff work while preserving result order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWorkspaceDiffEntriesWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return `file-${value}`;
      },
      3,
    );

    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => `file-${index}`));
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  test("expands untracked directories into file entries", async () => {
    const repoPath = await createTempDir("openpond-workspace-diff-");
    await git(repoPath, ["init"]);
    await writeFile(path.join(repoPath, "README.md"), "# Workspace\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    await mkdir(path.join(repoPath, "tools"), { recursive: true });
    await writeFile(path.join(repoPath, "tools", "run.ts"), "export const value = 1;\n", "utf8");
    await mkdir(path.join(repoPath, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repoPath, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf8");
    await mkdir(path.join(repoPath, ".venv", "lib"), { recursive: true });
    await writeFile(path.join(repoPath, ".venv", "lib", "site.py"), "print('ignore')\n", "utf8");
    await mkdir(path.join(repoPath, "__pycache__"), { recursive: true });
    await writeFile(path.join(repoPath, "__pycache__", "module.cpython-312.pyc"), "ignore\n", "utf8");
    await mkdir(path.join(repoPath, ".pytest_cache"), { recursive: true });
    await writeFile(path.join(repoPath, ".pytest_cache", "README.md"), "ignore\n", "utf8");
    await writeFile(path.join(repoPath, ".env.local"), "ignore=true\n", "utf8");

    const diff = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");
    const detail = await loadWorkspaceFileAtPath(repoPath, "tools/run.ts");
    const fullDiff = await loadWorkspaceDiffAtPath(repoPath, "workspace-test", { includeFileDetails: true });
    const changedPaths = diff.files.map((file) => file.path);

    expect(changedPaths).toEqual(["tools/run.ts"]);
    expect(diff.repoFiles).toContain("tools/run.ts");
    expect(diff.repoFiles.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(diff.repoFiles.some((file) => file.startsWith(".venv/"))).toBe(false);
    expect(diff.repoFiles.some((file) => file.startsWith("__pycache__/"))).toBe(false);
    expect(diff.repoFiles.some((file) => file.startsWith(".pytest_cache/"))).toBe(false);
    expect(diff.repoFiles).not.toContain(".env.local");
    expect(diff.repoFiles).not.toContain("tools");
    expect(diff.repoFiles).not.toContain("tools/");
    expect(diff.files[0]).toMatchObject({
      path: "tools/run.ts",
      status: "untracked",
      additions: 1,
      deletions: 0,
      patch: "",
      content: null,
    });
    expect(detail.patch).toContain("tools/run.ts");
    expect(detail.patch).not.toContain("Could not access");
    expect(detail.content).toBe("export const value = 1;\n");
    expect(fullDiff.files[0]?.patch).toContain("tools/run.ts");
    expect(fullDiff.files[0]?.content).toBe("export const value = 1;\n");
  });

  test("loads explicit ignored markdown files without adding them to diff files", async () => {
    const repoPath = await createTempDir("openpond-workspace-ignored-markdown-");
    await git(repoPath, ["init"]);
    await writeFile(path.join(repoPath, ".gitignore"), "docs/working-docs/\n", "utf8");
    await writeFile(path.join(repoPath, "README.md"), "# Workspace\n", "utf8");
    await git(repoPath, ["add", ".gitignore", "README.md"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    await mkdir(path.join(repoPath, "docs", "working-docs"), { recursive: true });
    await writeFile(path.join(repoPath, "docs", "working-docs", "plan.md"), "# Plan\n\nDetailed notes.\n", "utf8");

    const summary = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");
    const detail = await loadWorkspaceFileAtPath(repoPath, "docs/working-docs/plan.md");
    const basenameDetail = await loadWorkspaceFileAtPath(repoPath, "plan.md");

    expect(summary.files).toEqual([]);
    expect(summary.repoFiles).not.toContain("docs/working-docs/plan.md");
    expect(detail).toMatchObject({
      path: "docs/working-docs/plan.md",
      status: "unchanged",
      additions: 0,
      deletions: 0,
      patch: "",
      content: "# Plan\n\nDetailed notes.\n",
    });
    expect(basenameDetail).toMatchObject({
      path: "docs/working-docs/plan.md",
      content: "# Plan\n\nDetailed notes.\n",
    });
  });

  test("loads many changed files through summary and bounded full-detail paths", async () => {
    const repoPath = await createTempDir("openpond-workspace-diff-many-");
    await git(repoPath, ["init"]);
    await writeFile(path.join(repoPath, "README.md"), "# Workspace\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    await mkdir(path.join(repoPath, "src"), { recursive: true });
    for (let index = 0; index < 14; index += 1) {
      await writeFile(path.join(repoPath, "src", `item-${index}.ts`), `export const item${index} = ${index};\n`, "utf8");
    }

    const summary = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");
    const full = await loadWorkspaceDiffAtPath(repoPath, "workspace-test", { includeFileDetails: true });

    expect(summary.files).toHaveLength(14);
    const expectedPaths = Array.from({ length: 14 }, (_, index) => `src/item-${index}.ts`)
      .sort((left, right) => left.localeCompare(right));
    expect(summary.files.map((file) => file.path)).toEqual(
      expectedPaths,
    );
    expect(summary.files.every((file) => file.patch === "" && file.content === null)).toBe(true);
    expect(full.files).toHaveLength(14);
    const item13 = full.files.find((file) => file.path === "src/item-13.ts");
    expect(item13?.patch).toContain("src/item-13.ts");
    expect(item13?.content).toBe("export const item13 = 13;\n");
  });

  test("loads tracked full-detail patches from one combined git diff stream", async () => {
    const repoPath = await createTempDir("openpond-workspace-diff-combined-");
    const wrapperDir = await createTempDir("openpond-git-trace-");
    await git(repoPath, ["init"]);
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(repoPath, "src", "b.ts"), "export const b = 2;\n", "utf8");
    await writeFile(path.join(repoPath, "src", "c.ts"), "export const c = 3;\n", "utf8");
    await git(repoPath, ["add", "src"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    await writeFile(path.join(repoPath, "src", "a.ts"), "export const a = 10;\nexport const aa = 11;\n", "utf8");
    await writeFile(path.join(repoPath, "src", "b.ts"), "export const b = 20;\n", "utf8");
    await rm(path.join(repoPath, "src", "c.ts"));
    await writeFile(path.join(repoPath, "src", "untracked.ts"), "export const fresh = true;\n", "utf8");

    const realGit = await resolveGitBinary();
    const { logPath } = await installGitTraceWrapper(wrapperDir);
    const originalPath = process.env.PATH;
    const originalTracePath = process.env.OPENPOND_GIT_TRACE_ARGS;
    const originalRealGit = process.env.OPENPOND_REAL_GIT;
    process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.OPENPOND_GIT_TRACE_ARGS = logPath;
    process.env.OPENPOND_REAL_GIT = realGit;

    let fullDiff: WorkspaceDiffSummary;
    try {
      fullDiff = await loadWorkspaceDiffAtPath(repoPath, "workspace-test", { includeFileDetails: true });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalTracePath === undefined) delete process.env.OPENPOND_GIT_TRACE_ARGS;
      else process.env.OPENPOND_GIT_TRACE_ARGS = originalTracePath;
      if (originalRealGit === undefined) delete process.env.OPENPOND_REAL_GIT;
      else process.env.OPENPOND_REAL_GIT = originalRealGit;
    }

    const byPath = new Map(fullDiff.files.map((file) => [file.path, file]));
    expect(byPath.get("src/a.ts")?.patch).toContain("+export const a = 10;");
    expect(byPath.get("src/a.ts")?.patch).toContain("+export const aa = 11;");
    expect(byPath.get("src/a.ts")?.content).toBe("export const a = 10;\nexport const aa = 11;\n");
    expect(byPath.get("src/b.ts")?.patch).toContain("+export const b = 20;");
    expect(byPath.get("src/c.ts")).toMatchObject({ status: "deleted", content: null });
    expect(byPath.get("src/c.ts")?.patch).toContain("+++ /dev/null");
    expect(byPath.get("src/untracked.ts")?.patch).toContain("src/untracked.ts");

    const trace = await readFile(logPath, "utf8");
    const repoCommands = trace
      .split("\n")
      .map(parseGitTraceLine)
      .filter((command): command is GitTraceCommand => Boolean(command && command.cwd === repoPath));
    const trackedPatchCommands = repoCommands.filter((command) => (
      command.args.length === 8 &&
      command.args[0] === "-c" &&
      command.args[1] === "core.quotePath=false" &&
      command.args[2] === "diff" &&
      command.args[3] === "--no-ext-diff" &&
      command.args[4] === "--unified=80" &&
      command.args[5] === "HEAD" &&
      command.args[6] === "--" &&
      command.args[7] === "."
    ));
    const untrackedPatchCommands = repoCommands.filter((command) => (
      command.args.length === 6 &&
      command.args[0] === "diff" &&
      command.args[1] === "--no-index" &&
      command.args[2] === "--unified=80" &&
      command.args[3] === "--" &&
      command.args[4] === "/dev/null" &&
      command.args[5] === path.join(repoPath, "src", "untracked.ts")
    ));

    expect(trackedPatchCommands).toHaveLength(1);
    expect(trackedPatchCommands[0]?.args).toEqual([
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--unified=80",
      "HEAD",
      "--",
      ".",
    ]);
    expect(untrackedPatchCommands).toHaveLength(1);
  });

  test("caches unchanged diff summaries and invalidates on real worktree edits", async () => {
    const repoPath = await createTempDir("openpond-workspace-diff-cache-");
    await git(repoPath, ["init"]);
    await writeFile(path.join(repoPath, "README.md"), "# Workspace\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);
    await writeFile(path.join(repoPath, "notes.md"), "first\n", "utf8");

    const first = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");
    second.files[0]!.path = "mutated-by-caller.md";
    const third = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");

    expect(second.updatedAt).toBe(first.updatedAt);
    expect(third.files[0]?.path).toBe("notes.md");

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path.join(repoPath, "notes.md"), "first\nsecond\n", "utf8");
    const changed = await loadWorkspaceDiffAtPath(repoPath, "workspace-test");

    expect(changed.files[0]?.path).toBe("notes.md");
    expect(changed.files[0]?.additions).toBe(2);
  });

  test("treats slash-terminated tree paths as folders", () => {
    const tree = buildFileTree(["tools/"]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "tools", path: "tools", type: "folder", children: [] });
  });

  test("loads visible workspace images as binary previews", async () => {
    const repoPath = await createTempDir("openpond-workspace-image-");
    await git(repoPath, ["init"]);
    await mkdir(path.join(repoPath, "assets"), { recursive: true });
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(repoPath, "assets", "pixel.png"), imageBytes);

    const image = await loadWorkspaceImageFileAtPath(repoPath, "assets/pixel.png");
    const absoluteImage = await loadWorkspaceImageFileAtPath(repoPath, path.join(repoPath, "assets", "pixel.png"));
    const localImage = await readLocalImageFile(`file://${path.join(repoPath, "assets", "pixel.png")}`);
    await writeFile(path.join(repoPath, "assets", "pixel #1.png"), imageBytes);
    const hashImage = await readLocalImageFile(path.join(repoPath, "assets", "pixel #1.png"));

    expect(image.path).toBe("assets/pixel.png");
    expect(image.contentType).toBe("image/png");
    expect(image.bytes.equals(imageBytes)).toBe(true);
    expect(absoluteImage.path).toBe("assets/pixel.png");
    expect(localImage?.contentType).toBe("image/png");
    expect(localImage?.bytes.equals(imageBytes)).toBe(true);
    expect(hashImage?.contentType).toBe("image/png");
    expect(hashImage?.bytes.equals(imageBytes)).toBe(true);
  });

  test("loads workspace payloads from a Codex cwd without a registered project", async () => {
    const repoPath = await createTempDir("openpond-codex-cwd-workspace-");
    const storeDir = await createTempDir("openpond-codex-cwd-store-");
    await writeFile(path.join(repoPath, "README.md"), "# Codex cwd\n", "utf8");
    const store = new SqliteStore(storeDir);
    const payloads = createServerWorkspacePayloads({
      store,
      storeDir,
      openPondCacheScope: () => "test",
      findOpenPondApp: async () => {
        throw new Error("OpenPond app lookup should not run for local path workspaces");
      },
      loadAppPreferences: async () => AppPreferencesSchema.parse({}),
      bootstrapPayload: async () => ({}) as BootstrapPayload,
    });

    try {
      const workspaceId = localPathWorkspaceId(repoPath);
      const state = await payloads.workspaceStatePayload(workspaceId, false);
      const diff = await payloads.workspaceDiffPayload(workspaceId);
      const file = await payloads.workspaceFilePayload(workspaceId, "README.md");

      expect(state.appId).toBe(workspaceId);
      expect(state.initialized).toBe(true);
      expect(state.repoPath).toBe(repoPath);
      expect(diff.appId).toBe(workspaceId);
      expect(diff.repoFiles).toContain("README.md");
      expect(file.content).toBe("# Codex cwd\n");
    } finally {
      await store.close();
    }
  });

  test("suppresses unchanged dirty diff summaries", () => {
    const baseline = diffSummary([
      { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: "same patch", content: "same" },
    ]);
    const current = diffSummary([
      { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: "same patch", content: "same" },
    ]);

    expect(workspaceDiffSinceBaseline(current, baseline)).toBeNull();
  });

  test("keeps only files whose diff changed since baseline", () => {
    const baseline = diffSummary([
      { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: "old patch", content: "old" },
      { path: "README.md", status: "modified", additions: 1, deletions: 0, patch: "same patch", content: "same" },
    ]);
    const current = diffSummary([
      { path: "src/app.ts", status: "modified", additions: 4, deletions: 1, patch: "new patch", content: "new" },
      { path: "README.md", status: "modified", additions: 1, deletions: 0, patch: "same patch", content: "same" },
    ]);

    const result = workspaceDiffSinceBaseline(current, baseline);

    expect(result?.filesChanged).toBe(1);
    expect(result?.additions).toBe(4);
    expect(result?.deletions).toBe(1);
    expect(result?.files.map((file) => file.path)).toEqual(["src/app.ts"]);
  });
});
