import { existsSync } from "node:fs";
import path from "node:path";
import { stdin as input } from "node:process";

import { createRepo } from "../api";
import { OPENPOND_MANIFEST_FILE_NAME } from "../sandbox-template/manifest";
import { loadConfig } from "../config";
import {
  ensureApiKey,
  formatTokenizedRepoUrl,
  getGitRemoteUrl,
  parseBooleanOption,
  promptConfirm,
  redactToken,
  resolveBaseUrl,
  resolvePublicApiBaseUrl,
  resolveRepoUrl,
  runCommand,
  warnOnRepoHostMismatch,
} from "./common";
import { resolveGitBranch } from "./core-commands";
import type { SandboxTemplateManifest } from "../sandbox-template/manifest";

export async function resolveSandboxTemplateStartRepo(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>,
  projectPath: string
): Promise<string> {
  const explicitRepo =
    typeof options.repo === "string" ? options.repo.trim() : "";
  if (explicitRepo) {
    return normalizeSandboxTemplateRepoUrl(explicitRepo);
  }

  await ensureGitRepository(projectPath);
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  let originUrl = await getGitRemoteUrl(projectPath, "origin");
  if (!originUrl) {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const response = await createRepo(apiBase, apiKey, {
      name: manifest.name,
      description: manifest.description,
      repoInit: "empty",
      ...(teamId ? { teamId } : {}),
    });
    originUrl = resolveRepoUrl(response);
    const remoteResult = await runCommand(
      "git",
      ["remote", "add", "origin", originUrl],
      {
        cwd: projectPath,
      }
    );
    if (remoteResult.code !== 0) {
      throw new Error(
        `git remote add failed: ${
          remoteResult.stderr.trim() ||
          remoteResult.stdout.trim() ||
          "unknown error"
        }`
      );
    }
  }

  warnOnRepoHostMismatch(originUrl);
  await ensureGitCommitForSandboxTemplateStart(projectPath, options);
  if (!parseBooleanOption(options.noPush)) {
    const branch = await resolveSandboxTemplateStartBranch(
      projectPath,
      options
    );
    await pushGitBranchForSandboxTemplateStart(
      projectPath,
      originUrl,
      branch,
      apiKey,
      options
    );
  }
  return normalizeSandboxTemplateRepoUrl(originUrl);
}

export async function ensureGitRepository(projectPath: string): Promise<void> {
  const gitDir = path.join(projectPath, ".git");
  if (existsSync(gitDir)) return;
  const result = await runCommand("git", ["init"], { cwd: projectPath });
  if (result.code !== 0) {
    throw new Error(
      `git init failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`
    );
  }
}

export async function ensureGitCommitForSandboxTemplateStart(
  projectPath: string,
  options: Record<string, string | boolean>
): Promise<void> {
  const status = await runCommand("git", ["status", "--porcelain"], {
    cwd: projectPath,
  });
  if (status.code !== 0) {
    throw new Error(
      `git status failed: ${
        status.stderr.trim() || status.stdout.trim() || "unknown error"
      }`
    );
  }
  const head = await runCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: projectPath,
  });
  const hasHead = head.code === 0;
  const dirty = status.stdout.trim().length > 0;
  if (!dirty && hasHead) return;

  const shouldCommit =
    parseBooleanOption(options.commit) ||
    parseBooleanOption(options.yes) ||
    (input.isTTY
      ? await promptConfirm(
          hasHead
            ? "Commit local changes before starting the sandbox?"
            : "Create the initial git commit before starting the sandbox?",
          !hasHead
        )
      : false);

  if (!shouldCommit) {
    if (!hasHead) {
      throw new Error(
        "local repository has no commits; pass --commit or commit before starting"
      );
    }
    if (dirty) {
      console.warn(
        "warning: uncommitted local changes will not be included in the sandbox"
      );
    }
    return;
  }

  const add = await runCommand("git", ["add", "-A"], { cwd: projectPath });
  if (add.code !== 0) {
    throw new Error(
      `git add failed: ${
        add.stderr.trim() || add.stdout.trim() || "unknown error"
      }`
    );
  }
  const message =
    typeof options.commitMessage === "string" && options.commitMessage.trim()
      ? options.commitMessage.trim()
      : `start ${OPENPOND_MANIFEST_FILE_NAME} sandbox`;
  const commit = await runCommand("git", ["commit", "-m", message], {
    cwd: projectPath,
  });
  if (commit.code !== 0) {
    const output = commit.stderr.trim() || commit.stdout.trim();
    if (output.includes("nothing to commit") && hasHead) return;
    throw new Error(`git commit failed: ${output || "unknown error"}`);
  }
}

export async function resolveSandboxTemplateStartBranch(
  projectPath: string,
  options: Record<string, string | boolean>
): Promise<string> {
  const branchOption =
    typeof options.branch === "string" ? options.branch.trim() : "";
  const branch = branchOption || (await resolveGitBranch(projectPath));
  if (!branch) {
    throw new Error("unable to resolve git branch; pass --branch");
  }
  return branch;
}

export async function pushGitBranchForSandboxTemplateStart(
  projectPath: string,
  originUrl: string,
  branch: string,
  apiKey: string,
  options: Record<string, string | boolean>
): Promise<void> {
  let tokenRemote: string;
  try {
    tokenRemote = formatTokenizedRepoUrl(originUrl, apiKey);
  } catch {
    throw new Error("origin remote must be https for tokenized pushes");
  }
  const keepTokenRemote =
    parseBooleanOption(options.keepTokenRemote) ||
    parseBooleanOption(options.token) ||
    parseBooleanOption(options.setRemoteToken);
  const alreadyTokenized = originUrl.includes("x-access-token:");
  const restoreUrl = !keepTokenRemote && !alreadyTokenized ? originUrl : null;
  const previousPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_TERMINAL_PROMPT = "0";
  try {
    if (!alreadyTokenized) {
      const setResult = await runCommand(
        "git",
        ["remote", "set-url", "origin", tokenRemote],
        {
          cwd: projectPath,
        }
      );
      if (setResult.code !== 0) {
        throw new Error(
          `git remote set-url failed: ${redactToken(
            setResult.stderr.trim() ||
              setResult.stdout.trim() ||
              "unknown error"
          )}`
        );
      }
    }
    const push = await runCommand("git", ["push", "-u", "origin", branch], {
      cwd: projectPath,
      inherit: true,
    });
    if (push.code !== 0) {
      throw new Error("git push failed");
    }
  } finally {
    if (restoreUrl) {
      await runCommand("git", ["remote", "set-url", "origin", restoreUrl], {
        cwd: projectPath,
      }).catch(() => null);
    }
    if (previousPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = previousPrompt;
    }
  }
}

export function normalizeSandboxTemplateRepoIdentity(repoUrl: string): string {
  return normalizeSandboxTemplateRepoUrl(repoUrl).replace(/\.git$/, "");
}

export function normalizeSandboxTemplateRepoUrl(repoUrl: string): string {
  const parsed = new URL(repoUrl);
  parsed.username = "";
  parsed.password = "";
  const text = parsed.toString();
  return text.endsWith(".git") ? text : `${text.replace(/\/$/, "")}.git`;
}
