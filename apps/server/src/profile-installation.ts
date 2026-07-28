import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  defaultLocalProfileRepoPath,
  loadOpenPondProfileLibrary,
  loadOpenPondProfileStateForRef,
  registerLocalProfileRepo,
} from "@openpond/cloud";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import type { OpenPondProfileRef, OpenPondProfileState } from "@openpond/contracts";

const execFileAsync = promisify(execFile);

export async function installOpenPondProfile(input: {
  source: "github" | "openpond_git";
  repositoryId: string;
  url?: string | null;
  profile?: string | null;
}): Promise<OpenPondProfileState> {
  const repositoryId = normalizeRepositoryId(input.repositoryId);
  const root = path.join(path.dirname(defaultLocalProfileRepoPath()), "imports");
  const destination = path.join(root, `${safeName(repositoryId)}-${shortHash(`${input.source}:${repositoryId}`)}`);
  await mkdir(root, { recursive: true });
  const publicRemote = normalizedRemoteUrl(input.source, repositoryId, input.url);
  const cloneRemote = input.source === "openpond_git"
    ? await authenticatedOpenPondRemote(publicRemote)
    : publicRemote;
  if (!existsSync(path.join(destination, ".git"))) {
    await runGit(["clone", "--filter=blob:none", cloneRemote, destination]);
    if (cloneRemote !== publicRemote) await runGit(["-C", destination, "remote", "set-url", "origin", publicRemote]);
  } else {
    await updateProfileCheckout(destination, cloneRemote, publicRemote);
  }
  return registerLocalProfileRepo(destination, input.profile ?? undefined, {
    source: input.source,
    repositoryId,
  });
}

export async function updateInstalledOpenPondProfile(ref: OpenPondProfileRef): Promise<OpenPondProfileState> {
  const library = await loadOpenPondProfileLibrary();
  const entry = library.profiles.find((candidate) =>
    candidate.ref.source === ref.source &&
    candidate.ref.repositoryId === ref.repositoryId &&
    candidate.ref.profileId === ref.profileId,
  );
  if (!entry) throw new Error(`Profile "${ref.profileId}" is not installed.`);
  if (ref.source === "local") return loadOpenPondProfileStateForRef(ref);
  const publicRemote = normalizedRemoteUrl(ref.source, ref.repositoryId, entry.state.git?.remoteUrl);
  const remote = ref.source === "openpond_git" ? await authenticatedOpenPondRemote(publicRemote) : publicRemote;
  await updateProfileCheckout(entry.repoPath, remote, publicRemote);
  return registerLocalProfileRepo(entry.repoPath, ref.profileId, {
    source: ref.source,
    repositoryId: ref.repositoryId,
  });
}

async function updateProfileCheckout(destination: string, remote: string, publicRemote: string): Promise<void> {
  const status = await runGit(["-C", destination, "status", "--porcelain"]);
  if (status.trim()) throw new Error("Commit or discard local changes before updating this Profile.");
  await runGit(["-C", destination, "remote", "set-url", "origin", remote]);
  try {
    await runGit(["-C", destination, "pull", "--ff-only"]);
  } finally {
    if (remote !== publicRemote) await runGit(["-C", destination, "remote", "set-url", "origin", publicRemote]);
  }
}

function normalizedRemoteUrl(
  source: OpenPondProfileRef["source"],
  repositoryId: string,
  supplied?: string | null,
): string {
  const raw = supplied?.trim() || (source === "github"
    ? `https://github.com/${repositoryId}`
    : `https://openpond.ai/${repositoryId}`);
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/$/, "").replace(/\.git$/, "") + ".git";
}

async function authenticatedOpenPondRemote(remote: string): Promise<string> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) throw new Error("Sign in to OpenPond before installing a private OpenPond Git Profile.");
  const url = new URL(remote);
  url.username = "x-access-token";
  url.password = context.token;
  return url.toString();
}

function normalizeRepositoryId(value: string): string {
  const normalized = value.trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Repository must use owner/repository format.");
  }
  return normalized;
}

function safeName(repositoryId: string): string {
  return repositoryId.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "profile";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

async function runGit(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout;
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(failed.stderr?.trim() || failed.stdout?.trim() || failed.message || "Git command failed.");
  }
}
