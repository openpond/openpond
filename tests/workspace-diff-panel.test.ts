import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceDiffPanel } from "../apps/web/src/components/workspace-diff/WorkspaceDiffPanel";
import { UnifiedDiffPreview } from "../apps/web/src/components/workspace-diff/WorkspaceFilePreview";
import type { WorkspaceDiffFile } from "@openpond/contracts";

const noop = () => undefined;
const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return String(result.stdout);
}

function diffFile(path: string, patch: string): WorkspaceDiffFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    patch,
    content: null,
  };
}

describe("Workspace diff panel", () => {
  test("does not prompt local projects to sync while workspace state is loading", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceDiffPanel, {
        appId: "local_project_1",
        workspaceId: "local_project_1",
        workspaceKind: "local_project",
        connection: null,
        diff: null,
        editorPreferences: null,
        loading: false,
        workspaceName: "Local project",
        workspaceInitialized: false,
        workspaceError: null,
        expanded: false,
        onRefresh: noop,
        onResizeStart: noop,
        onToggleExpanded: noop,
        onOpenBrowser: noop,
        onOpenBrowserUrl: noop,
      }),
    );

    expect(markup).toContain("Loading workspace files");
    expect(markup).not.toContain("Sync locally to show files");
  });

  test("does not prompt non-syncable Codex workspaces to sync", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceDiffPanel, {
        appId: null,
        workspaceId: null,
        workspaceKind: null,
        connection: null,
        diff: null,
        editorPreferences: null,
        loading: false,
        workspaceName: "Codex chat",
        workspaceInitialized: false,
        workspaceError: null,
        expanded: false,
        onRefresh: noop,
        onResizeStart: noop,
        onToggleExpanded: noop,
        onOpenBrowser: noop,
        onOpenBrowserUrl: noop,
      }),
    );

    expect(markup).toContain("No local files to show");
    expect(markup).not.toContain("Sync locally to show files");
  });

  test("folds large real git hunk context instead of synthetic spacer truncation", async () => {
    const repoPath = await createTempDir("openpond-diff-panel-fold-");
    await git(repoPath, ["init"]);
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    const lines = Array.from({ length: 220 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
    await writeFile(path.join(repoPath, "src", "large.ts"), `${lines.join("\n")}\n`, "utf8");
    await git(repoPath, ["add", "src/large.ts"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    lines[109] = "export const value110 = 999;";
    await writeFile(path.join(repoPath, "src", "large.ts"), `${lines.join("\n")}\n`, "utf8");
    const patch = await git(repoPath, ["diff", "--unified=80", "HEAD", "--", "src/large.ts"]);
    const markup = renderToStaticMarkup(
      createElement(UnifiedDiffPreview, {
        file: diffFile("src/large.ts", patch),
        wordWrap: false,
        workspaceName: "Workspace",
      }),
    );

    expect(markup).toContain("unmodified lines");
    expect(markup).not.toContain("42 unmodified lines");
    expect(markup).not.toContain("diff truncated");
    expect(markup).toContain("value110");
    expect(markup).toContain("999");
    expect(markup).toContain("value105");
    expect(markup).not.toContain("value70");
  });

  test("virtualizes large real git patch row sets", async () => {
    const repoPath = await createTempDir("openpond-diff-panel-virtual-");
    await git(repoPath, ["init"]);
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    const lines = Array.from({ length: 900 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
    await writeFile(path.join(repoPath, "src", "many.ts"), `${lines.join("\n")}\n`, "utf8");
    await git(repoPath, ["add", "src/many.ts"]);
    await git(repoPath, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"]);

    for (let lineNumber = 20; lineNumber <= 880; lineNumber += 20) {
      lines[lineNumber - 1] = `export const value${lineNumber} = ${lineNumber * 10};`;
    }
    await writeFile(path.join(repoPath, "src", "many.ts"), `${lines.join("\n")}\n`, "utf8");
    const patch = await git(repoPath, ["diff", "--unified=3", "HEAD", "--", "src/many.ts"]);
    const markup = renderToStaticMarkup(
      createElement(UnifiedDiffPreview, {
        file: diffFile("src/many.ts", patch),
        wordWrap: false,
        workspaceName: "Workspace",
      }),
    );

    expect(markup).toContain("workspace-diff-code virtualized");
    expect(markup).toContain("workspace-diff-virtual-spacer");
    expect(markup).toContain("value20");
    expect(markup).not.toContain("value880");
  });

  test("renders workspace breadcrumbs from repo-relative paths", () => {
    const markup = renderToStaticMarkup(
      createElement(UnifiedDiffPreview, {
        file: diffFile("/home/glu/Projects/all/openpond/docs/notes.md", ""),
        wordWrap: false,
        workspaceName: "openpond",
        workspaceRootPath: "/home/glu/Projects/all/openpond",
      }),
    );

    expect(markup).toContain('class="workspace-file-breadcrumbs" title="openpond &gt; docs/notes.md"');
    expect(markup).not.toContain('title="openpond &gt; /home');
  });

  test("does not prefix outside absolute paths with the workspace name", () => {
    const markup = renderToStaticMarkup(
      createElement(UnifiedDiffPreview, {
        file: diffFile("/tmp/notes.md", ""),
        wordWrap: false,
        workspaceName: "openpond",
        workspaceRootPath: "/home/glu/Projects/all/openpond",
      }),
    );

    expect(markup).toContain('class="workspace-file-breadcrumbs" title="/tmp/notes.md"');
    expect(markup).not.toContain('title="openpond &gt; /tmp');
  });
});
