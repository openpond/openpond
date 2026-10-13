import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { AppPreferencesSchema, localPathWorkspaceId, WorkspaceDiffFileSchema, type BootstrapPayload, type WorkspaceDiffSummary } from "@openpond/contracts";
import {
  clearWorkspaceDiffCacheForTests,
  loadGitCommitDiffAtPath,
  loadWorkspaceDiffAtPath,
  loadWorkspaceFileAtPath,
  loadWorkspaceImageFileAtPath,
  mapWorkspaceDiffEntriesWithConcurrency,
} from "../apps/server/src/workspace/workspace-diff";
import { readLocalImageFile } from "../apps/server/src/workspace/workspace-common";
import { loadLocalOutputFile } from "../apps/server/src/workspace/local-output-files";
import { workspaceDiffSinceBaseline } from "../apps/server/src/workspace/server-workspace-session-workflows";
import { createServerWorkspacePayloads } from "../apps/server/src/workspace/server-workspace-payloads";
import { SqliteStore } from "../apps/server/src/store/store";
import { buildFileTree } from "../apps/web/src/components/workspace-diff/workspace-diff-summary-model";
import { FileLoadTracker } from "../apps/web/src/components/workspace-diff/file-load-tracker";
import { createPreviewWorkQueue } from "../apps/web/src/components/workspace-diff/preview-work-queue";

// A discarded thumbnail must neither hold up the next document nor start
// expensive work after its New tab has been closed.
test("thumbnail work is serialized and closing a preview releases the queue", async () => {
  const queue = createPreviewWorkQueue(async () => {});
  const active = new AbortController();
  const skipped = new AbortController();
  const calls: string[] = [];
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const first = queue(active.signal, async () => {
    calls.push("first"); started();
    await new Promise<void>(resolve => active.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const second = queue(skipped.signal, async () => { calls.push("closed"); });
  const third = queue(new AbortController().signal, async () => { calls.push("next"); });
  await start;
  expect(calls).toEqual(["first"]);
  skipped.abort(); active.abort();
  await Promise.all([first, second, third]);
  expect(calls).toEqual(["first", "next"]);
});

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
  test("loads a reviewed commit range with file patches and head content", async () => {
    const repoPath = await createTempDir("openpond-candidate-diff-");
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.local"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "agent.ts"), "export const behavior = 'base';\n", "utf8");
    await git(repoPath, ["add", "-A"]);
    await git(repoPath, ["commit", "-m", "base"]);
    const base = String((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout).trim();
    await writeFile(path.join(repoPath, "src", "agent.ts"), "export const behavior = 'candidate';\n", "utf8");
    await git(repoPath, ["add", "-A"]);
    await git(repoPath, ["commit", "-m", "candidate"]);
    const head = String((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout).trim();

    const summary = await loadGitCommitDiffAtPath(
      repoPath,
      "candidate:run:candidate",
      base,
      head,
    );

    expect(summary).toMatchObject({
      appId: "candidate:run:candidate",
      filesChanged: 1,
      additions: 1,
      deletions: 1,
    });
    expect(summary.files[0]).toMatchObject({
      path: "src/agent.ts",
      status: "modified",
      content: "export const behavior = 'candidate';\n",
    });
    expect(summary.files[0]?.patch).toContain("export const behavior = 'candidate';");
  });

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
    const absoluteDetail = await loadWorkspaceFileAtPath(
      repoPath,
      path.join(repoPath, "docs", "working-docs", "plan.md"),
    );

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
    expect(absoluteDetail).toMatchObject({
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

  test("loads tracked and untracked full-detail patches", async () => {
    const repoPath = await createTempDir("openpond-workspace-diff-combined-");
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

    const fullDiff = await loadWorkspaceDiffAtPath(repoPath, "workspace-test", { includeFileDetails: true });

    const byPath = new Map(fullDiff.files.map((file) => [file.path, file]));
    expect(byPath.get("src/a.ts")?.patch).toContain("+export const a = 10;");
    expect(byPath.get("src/a.ts")?.patch).toContain("+export const aa = 11;");
    expect(byPath.get("src/a.ts")?.content).toBe("export const a = 10;\nexport const aa = 11;\n");
    expect(byPath.get("src/b.ts")?.patch).toContain("+export const b = 20;");
    expect(byPath.get("src/c.ts")).toMatchObject({ status: "deleted", content: null });
    expect(byPath.get("src/c.ts")?.patch).toContain("+++ /dev/null");
    expect(byPath.get("src/untracked.ts")?.patch).toContain("src/untracked.ts");
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

  test("loads workspace PDFs as bounded base64 document previews", async () => {
    const repoPath = await createTempDir("openpond-workspace-pdf-");
    await git(repoPath, ["init"]);
    const pdfBytes = Buffer.from("%PDF-1.4\npreview\n%%EOF\n", "utf8");
    await writeFile(path.join(repoPath, "report.pdf"), pdfBytes);

    const file = await loadWorkspaceFileAtPath(repoPath, "report.pdf");

    expect(file.path).toBe("report.pdf");
    expect(Buffer.from(file.content ?? "", "base64")).toEqual(pdfBytes);
  });

  // Failure story: generated PPTX outputs were decoded as UTF-8 and opened in
  // the editor; metadata must survive the API boundary even without an extension.
  test("preserves PowerPoint bytes and preview metadata for named and extensionless outputs", async () => {
    const repoPath = await createTempDir("openpond-workspace-presentation-");
    const outputDir = await createTempDir("openpond-output-presentation-");
    const bytes = await readFile(new URL("./fixtures/workspace-presentation.pptx", import.meta.url));
    for (const name of ["slides.pptx", "001-artifact"]) {
      const outputPath = path.join(outputDir, name);
      await writeFile(outputPath, bytes);
      const file = WorkspaceDiffFileSchema.parse(await loadLocalOutputFile(repoPath, outputPath));
      expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
      expect(file.contentEncoding).toBe("base64");
      expect(Buffer.from(file.content ?? "", "base64")).toEqual(bytes);
    }
    await writeFile(path.join(repoPath, "slides.pptx"), bytes);
    const file = WorkspaceDiffFileSchema.parse(await loadWorkspaceFileAtPath(repoPath, "slides.pptx"));
    expect(file.contentEncoding).toBe("base64");
    expect(Buffer.from(file.content ?? "", "base64")).toEqual(bytes);
    await truncate(path.join(repoPath, "slides.pptx"), 21 * 1024 * 1024);
    await expect(loadWorkspaceFileAtPath(repoPath, "slides.pptx")).rejects.toThrow();
  });

  test("loads workspace payloads from a Codex cwd without a registered project", async () => {
    const repoPath = await createTempDir("openpond-codex-cwd-workspace-");
    const storeDir = await createTempDir("openpond-codex-cwd-store-");
    await writeFile(path.join(repoPath, "README.md"), "# Codex cwd\n", "utf8");
    const outputDir = await createTempDir("openpond-local-output-");
    const outputPath = path.join(outputDir, "report.pdf");
    const outputBytes = Buffer.from("%PDF-1.4\nlocal output\n%%EOF\n");
    await writeFile(outputPath, outputBytes);
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
      // Explicit local outputs open outside the cwd, while workspace-relative
      // traversal and the shared/hosted workspace loader remain contained.
      const output = await payloads.workspaceFilePayload(workspaceId, outputPath);
      expect(output.path).toBe(outputPath);
      expect(Buffer.from(output.content ?? "", "base64")).toEqual(outputBytes);
      const homePath = `~/${path.relative(os.homedir(), outputPath)}`;
      const homeOutput = await payloads.workspaceFilePayload(workspaceId, homePath);
      expect(homeOutput.path).toBe(homePath);
      expect(homeOutput.content).toBe(output.content);
      const imagePath = path.join(outputDir, "slide.png");
      const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7l8S8AAAAASUVORK5CYII=", "base64");
      await writeFile(imagePath, imageBytes);
      expect((await payloads.workspaceImagePayload(workspaceId, imagePath)).bytes).toEqual(imageBytes);
      await expect(payloads.workspaceImagePayload(workspaceId, path.relative(repoPath, imagePath))).rejects.toThrow("Image not found");
      await expect(payloads.workspaceFilePayload(workspaceId, path.relative(repoPath, outputPath))).rejects.toThrow("File not found");
      await expect(loadWorkspaceFileAtPath(repoPath, outputPath)).rejects.toThrow("File not found");
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


// A model can overwrite a document under the same name and byte length or
// replace it atomically. Metadata must detect both without reading its body,
// and polling must retain the same workspace boundary as file previews.
test("open file versions detect same-name edits and replacements within the workspace boundary", async () => {
  const { workspaceFileVersion } = await import("../apps/server/src/workspace/workspace-file-version");
  const root = await mkdtemp(path.join(os.tmpdir(), "openpond-file-version-"));
  tempDirs.push(root);
  const folder = path.join(root, "project");
  await mkdir(folder);
  const target = path.join(folder, "deck.pptx");
  await writeFile(target, "first");
  const initial = await workspaceFileVersion(folder, "deck.pptx");
  await writeFile(target, "other");
  await utimes(target, new Date("2026-01-01"), new Date("2026-01-01"));
  const edited = await workspaceFileVersion(folder, "deck.pptx");
  expect(edited.exists).toBe(true);
  expect(edited.revision).not.toBe(initial.revision);
  await writeFile(path.join(folder, "next.pptx"), "third");
  await rename(path.join(folder, "next.pptx"), target);
  const replaced = await workspaceFileVersion(folder, target);
  expect(replaced.revision).not.toBe(edited.revision);
  await writeFile(target, "third");
  await utimes(target, new Date("2026-02-01"), new Date("2026-02-01"));
  expect((await workspaceFileVersion(folder, target)).revision).toBe(replaced.revision);
  expect(await workspaceFileVersion(folder, "missing.pptx")).toMatchObject({ exists: false, revision: null });
  await writeFile(path.join(root, "outside.pptx"), "other");
  await expect(workspaceFileVersion(folder, "../outside.pptx", true)).rejects.toThrow("outside the workspace");
  await expect(workspaceFileVersion(folder, path.join(root, "outside.pptx"))).rejects.toThrow("outside the workspace");
  expect((await workspaceFileVersion(folder, path.join(root, "outside.pptx"), true)).exists).toBe(true);
  await symlink(root, path.join(folder, "escape"), "dir");
  await expect(workspaceFileVersion(folder, "escape/outside.pptx")).rejects.toThrow("outside the workspace");
});

// Network responses can complete in any order while the user changes tabs.
test("file reads cannot reopen closed tabs or replace a newer request", () => {
  const loads = new FileLoadTracker();
  expect(loads.receive("a.pdf", { loadId: 1, loading: true })).toBe("open");
  expect(loads.receive("b.pdf", { loadId: 2, loading: true })).toBe("open");
  expect(loads.receive("a.pdf", { loadId: 1 })).toBe("complete");
  loads.close("b.pdf");
  expect(loads.receive("b.pdf", { loadId: 2 })).toBe("ignore");
  loads.receive("a.pdf", { loadId: 3, loading: true });
  loads.receive("a.pdf", { loadId: 4, loading: true });
  expect(loads.receive("a.pdf", { loadId: 4 })).toBe("complete");
  expect(loads.receive("a.pdf", { loadId: 3 })).toBe("ignore");
  expect(loads.receive("fast.pdf", { loadId: 5 })).toBe("open");
  loads.receive("local.pdf", { loadId: 6, loading: true });
  loads.receive("remote.pdf", { loadId: 7, loading: true });
  loads.retain(new Set(["local.pdf"]));
  expect(loads.receive("remote.pdf", { loadId: 7 })).toBe("ignore");
  expect(loads.receive("local.pdf", { loadId: 6 })).toBe("complete");
});
