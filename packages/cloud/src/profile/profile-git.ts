import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  OpenPondProfileGitFileChange,
  OpenPondProfileGitState,
} from "./local-profile-types.js";

const PROFILE_REPO_GITIGNORE = [
  "**/node_modules/",
  "**/.env",
  "**/.env.*",
  "**/.openpond/goals/",
  "**/.openpond/traces/",
  "**/.openpond/vendor/",
  "**/.openpond/eval-results.json",
  "**/.openpond/artifact-index.json",
  "",
].join("\n");

export async function ensureProfileGitRepo(repoPath: string): Promise<void> {
  if (!existsSync(path.join(repoPath, ".git"))) {
    const init = await runGitCommand(repoPath, ["init", "-b", "main"]);
    if (init.code !== 0) {
      throw new Error(gitFailureMessage("git init", init));
    }
  }

  const gitignorePath = path.join(repoPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, PROFILE_REPO_GITIGNORE, "utf8");
  } else {
    await ensureProfileGitignoreRules(gitignorePath);
  }

  if (await hasGitHead(repoPath)) return;
  const state = await loadProfileGitState(repoPath);
  if (!state.dirty && state.files.length === 0) return;

  const add = await runGitCommand(repoPath, ["add", "-A"]);
  if (add.code !== 0) {
    throw new Error(gitFailureMessage("git add", add));
  }
  const commit = await runGitCommand(repoPath, ["commit", "-m", "Initialize OpenPond profile"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "OpenPond",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "openpond@example.invalid",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "OpenPond",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "openpond@example.invalid",
    },
  });
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    throw new Error(gitFailureMessage("git commit", commit));
  }
}

async function ensureProfileGitignoreRules(gitignorePath: string): Promise<void> {
  const current = await readFile(gitignorePath, "utf8").catch(() => "");
  const missing = PROFILE_REPO_GITIGNORE.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !current.split(/\r?\n/).some((existing) => existing.trim() === line));
  if (missing.length === 0) return;
  const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  await writeFile(gitignorePath, `${current}${suffix}${missing.join("\n")}\n`, "utf8");
}

export async function loadProfileGitState(repoPath: string): Promise<OpenPondProfileGitState> {
  if (!existsSync(path.join(repoPath, ".git"))) {
    return {
      isRepo: false,
      branch: null,
      head: null,
      shortHead: null,
      dirty: false,
      upstream: null,
      ahead: null,
      behind: null,
      remoteUrl: null,
      files: [],
      error: null,
    };
  }

  const inside = await runGitCommand(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return {
      isRepo: false,
      branch: null,
      head: null,
      shortHead: null,
      dirty: false,
      upstream: null,
      ahead: null,
      behind: null,
      remoteUrl: null,
      files: [],
      error: inside.stderr.trim() || inside.stdout.trim() || "not a Git work tree",
    };
  }

  const [branch, head, status, upstream, remoteUrl] = await Promise.all([
    gitText(repoPath, ["branch", "--show-current"]),
    gitText(repoPath, ["rev-parse", "HEAD"]),
    runGitCommand(repoPath, ["status", "--porcelain=v1", "-uall"]),
    gitText(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    gitText(repoPath, ["remote", "get-url", "origin"]),
  ]);
  const files = status.code === 0 ? parsePorcelainStatus(status.stdout) : [];
  const aheadBehind = upstream ? await loadAheadBehind(repoPath) : { ahead: null, behind: null };
  const resolvedHead = head || null;

  return {
    isRepo: true,
    branch: branch || null,
    head: resolvedHead,
    shortHead: resolvedHead ? resolvedHead.slice(0, 12) : null,
    dirty: files.length > 0,
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    remoteUrl,
    files,
    error: status.code === 0 ? null : gitFailureMessage("git status", status),
  };
}

export async function commitProfileChanges(repoPath: string, message: string): Promise<{
  committed: boolean;
  stdout: string;
  stderr: string;
  state: OpenPondProfileGitState;
}> {
  const before = await loadProfileGitState(repoPath);
  if (!before.isRepo) {
    throw new Error(before.error ?? "Active OpenPond profile source is not a Git repo.");
  }
  if (!before.dirty) {
    return {
      committed: false,
      stdout: "",
      stderr: "",
      state: before,
    };
  }

  const add = await runGitCommand(repoPath, ["add", "-A"]);
  if (add.code !== 0) {
    throw new Error(gitFailureMessage("git add", add));
  }
  const commit = await runGitCommand(repoPath, ["commit", "-m", message]);
  if (commit.code !== 0) {
    throw new Error(gitFailureMessage("git commit", commit));
  }

  return {
    committed: true,
    stdout: commit.stdout,
    stderr: commit.stderr,
    state: await loadProfileGitState(repoPath),
  };
}

export async function profileGitHead(repoPath: string): Promise<string | null> {
  return gitText(repoPath, ["rev-parse", "HEAD"]);
}

async function hasGitHead(repoPath: string): Promise<boolean> {
  const result = await runGitCommand(repoPath, ["rev-parse", "--verify", "HEAD"]);
  return result.code === 0;
}

async function loadAheadBehind(repoPath: string): Promise<{ ahead: number | null; behind: number | null }> {
  const result = await runGitCommand(repoPath, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (result.code !== 0) return { ahead: null, behind: null };
  const [behindRaw, aheadRaw] = result.stdout.trim().split(/\s+/);
  const behind = behindRaw ? Number.parseInt(behindRaw, 10) : Number.NaN;
  const ahead = aheadRaw ? Number.parseInt(aheadRaw, 10) : Number.NaN;
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

async function gitText(repoPath: string, args: string[]): Promise<string | null> {
  const result = await runGitCommand(repoPath, args);
  if (result.code !== 0) return null;
  const text = result.stdout.trim();
  return text || null;
}

function parsePorcelainStatus(output: string): OpenPondProfileGitFileChange[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawIndex = line[0] ?? " ";
      const rawWorktree = line[1] ?? " ";
      const status = `${rawIndex}${rawWorktree}`.trim() || "changed";
      const rawPath = line.slice(3);
      const renameParts = rawPath.split(" -> ");
      const indexStatus = rawIndex === " " ? null : rawIndex;
      const worktreeStatus = rawWorktree === " " ? null : rawWorktree;
      const pathValue = renameParts.length === 2 ? renameParts[1]! : rawPath;
      const originalPath = renameParts.length === 2 ? renameParts[0]! : null;
      return {
        path: unquoteGitPath(pathValue),
        originalPath: originalPath ? unquoteGitPath(originalPath) : null,
        indexStatus,
        worktreeStatus,
        status,
        category: gitChangeCategory(indexStatus, worktreeStatus),
      };
    });
}

function gitChangeCategory(
  indexStatus: string | null,
  worktreeStatus: string | null,
): OpenPondProfileGitFileChange["category"] {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "M" || worktreeStatus === "M") return "modified";
  return "changed";
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function gitFailureMessage(
  label: string,
  result: { code: number | null; stdout: string; stderr: string },
): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail || `${label} failed with exit code ${result.code ?? "unknown"}`;
}

export async function runGitCommand(
  repoPath: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd: repoPath,
      env: options.env,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
