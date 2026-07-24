import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  OpenPondProfilePublicationPreviewRequestSchema,
  OpenPondProfilePublicationPublishRequestSchema,
  type OpenPondProfilePublicationPreview,
  type OpenPondProfilePublicationPreviewRequest,
  type OpenPondProfilePublicationResult,
} from "@openpond/contracts";
import { updateAppCodeVisibility } from "@openpond/cloud/api";
import {
  createOpenPondRepoApp,
  loadOpenPondAccountContext,
  loadOpenPondApps,
} from "@openpond/runtime";
import { loadOpenPondProfileLibrary } from "@openpond/cloud";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MAX_PUBLICATION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PUBLICATION_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PUBLICATION_FILES = 1_000;
const SECRET_PATH_PATTERN = /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))|(?:^|\/)(?:traces?|\.openpond|node_modules)(?:\/|$)/i;
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"']{12,}["']/i,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
];

type PublicationPlan = {
  request: OpenPondProfilePublicationPreviewRequest;
  preview: OpenPondProfilePublicationPreview;
  repoPath: string;
  files: Array<{ sourcePath: string | null; relativePath: string; contents: Buffer; category: string }>;
  existingTarget: ExistingTarget | null;
};

type ExistingTarget = {
  owner: string;
  repository: string;
  remoteUrl: string;
  webUrl: string;
  defaultBranch: string;
  appId?: string;
  visibility?: "private" | "public";
};

type PublicationRequiredSelection = {
  kind: "Agent" | "Skill";
  label: string;
  prefix: string;
};

export async function previewOpenPondProfilePublication(
  input: unknown,
): Promise<OpenPondProfilePublicationPreview> {
  return (await buildPublicationPlan(OpenPondProfilePublicationPreviewRequestSchema.parse(input))).preview;
}

export async function publishOpenPondProfile(
  input: unknown,
): Promise<OpenPondProfilePublicationResult> {
  const request = OpenPondProfilePublicationPublishRequestSchema.parse(input);
  const plan = await buildPublicationPlan(request);
  if (plan.preview.sourceHash !== request.expectedSourceHash) {
    throw new Error("Profile source changed after preview. Review the publication preview again.");
  }
  if (plan.preview.blockedReasons.length > 0) {
    throw new Error(plan.preview.blockedReasons.join(" "));
  }

  const exportPath = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-profile-publish-"));
  try {
    for (const file of plan.files) {
      const destination = path.join(exportPath, file.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.contents);
    }
    await runRequired("git", ["init", "-b", "master"], exportPath);
    await runRequired("git", ["config", "user.name", "OpenPond"], exportPath);
    await runRequired("git", ["config", "user.email", "profiles@openpond.ai"], exportPath);
    await runRequired("git", ["add", "."], exportPath);
    await runRequired("git", ["commit", "-m", `Publish Profile ${request.ref.profileId}`], exportPath);
    const revision = (await runRequired("git", ["rev-parse", "HEAD"], exportPath)).trim();
    const target = request.target.provider === "github"
      ? await publishToGitHub(exportPath, request, plan.existingTarget)
      : await publishToOpenPondGit(exportPath, request, plan.existingTarget);
    return {
      provider: request.target.provider,
      owner: target.owner,
      repository: request.target.repository,
      visibility: request.target.visibility,
      remoteUrl: target.remoteUrl,
      webUrl: target.webUrl,
      revision,
    };
  } finally {
    await fs.rm(exportPath, { recursive: true, force: true });
  }
}

async function buildPublicationPlan(
  request: OpenPondProfilePublicationPreviewRequest,
): Promise<PublicationPlan> {
  const library = await loadOpenPondProfileLibrary();
  const entry = library.profiles.find((candidate) =>
    candidate.ref.source === request.ref.source &&
    candidate.ref.repositoryId === request.ref.repositoryId &&
    candidate.ref.profileId === request.ref.profileId,
  );
  if (!entry) throw new Error(`Profile "${request.ref.profileId}" is not installed.`);
  if (!entry.state.repoPath || !entry.state.sourcePath) throw new Error("Profile source is unavailable.");

  const repoPath = path.resolve(entry.state.repoPath);
  const profileRoot = normalizePath(path.relative(repoPath, entry.state.sourcePath));
  const status = await runCommand("git", ["status", "--porcelain=v1"], repoPath);
  const blockedReasons: string[] = [];
  if (status.code !== 0) blockedReasons.push("Profile source is not a readable Git repository.");
  if (status.stdout.trim()) blockedReasons.push("Commit or discard every change in the Profile repository before publishing.");
  if (request.selection.agentIds.length === 0 && request.selection.skillNames.length === 0) {
    blockedReasons.push("Select at least one Agent or Skill to publish.");
  }

  const trackedResult = await runCommand("git", ["ls-files", "-z"], repoPath);
  if (trackedResult.code !== 0) throw new Error(trackedResult.stderr || "Unable to list tracked Profile files.");
  const tracked = trackedResult.stdout.split("\0").filter(Boolean).map(normalizePath);
  const prefixes = new Map<string, string>();
  const requiredSelections: PublicationRequiredSelection[] = [];
  const exact = new Map<string, string>([
    ["openpond-profile.json", "manifest"],
    ["README.md", "documentation"],
    ["LICENSE", "documentation"],
    ["LICENSE.md", "documentation"],
    [profilePublicationRelativePath(profileRoot, "settings/profile.yaml"), "settings"],
    [profilePublicationRelativePath(profileRoot, "openpond.yaml"), "settings"],
    [profilePublicationRelativePath(profileRoot, "openpond.lock"), "settings"],
    [profilePublicationRelativePath(profileRoot, "package.json"), "settings"],
    [profilePublicationRelativePath(profileRoot, "pnpm-lock.yaml"), "settings"],
    [profilePublicationRelativePath(profileRoot, "package-lock.json"), "settings"],
    [profilePublicationRelativePath(profileRoot, "yarn.lock"), "settings"],
    [profilePublicationRelativePath(profileRoot, "tsconfig.json"), "settings"],
  ]);
  for (const agentId of request.selection.agentIds) {
    const agent = entry.state.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      blockedReasons.push(`Selected Agent "${agentId}" no longer exists.`);
      continue;
    }
    const relativeAgentPath = agent.id === "default" ? "agent" : normalizePath(agent.path);
    const prefix = `${profilePublicationRelativePath(profileRoot, relativeAgentPath)}/`;
    prefixes.set(prefix, "agent");
    requiredSelections.push({ kind: "Agent", label: agentId, prefix });
  }
  for (const skillName of request.selection.skillNames) {
    const skill = entry.state.skills.find((candidate) => candidate.name === skillName);
    if (!skill) {
      blockedReasons.push(`Selected Skill "${skillName}" no longer exists.`);
      continue;
    }
    const prefix = `${profilePublicationRelativePath(profileRoot, path.dirname(skill.path))}/`;
    prefixes.set(prefix, "skill");
    requiredSelections.push({ kind: "Skill", label: skillName, prefix });
  }
  for (const optional of request.selection.optionalContent) {
    prefixes.set(`${profilePublicationRelativePath(profileRoot, optional)}/`, optional);
  }

  const excludedFiles: string[] = [];
  const selected = tracked.flatMap((relativePath) => {
    const category = exact.get(relativePath) ?? [...prefixes].find(([prefix]) => relativePath.startsWith(prefix))?.[1];
    if (!category) return [];
    if (profilePublicationPathIsSensitive(relativePath)) {
      excludedFiles.push(relativePath);
      return [];
    }
    return [{ relativePath, category }];
  });
  for (const missing of profilePublicationSelectionsWithoutTrackedSource(
    tracked,
    requiredSelections,
  )) {
    blockedReasons.push(
      `Selected ${missing.kind} "${missing.label}" has no tracked source files. Add and commit its source before publishing.`,
    );
  }
  if (selected.length > MAX_PUBLICATION_FILES) {
    blockedReasons.push(
      `Publication contains ${selected.length} files; the maximum is ${MAX_PUBLICATION_FILES}.`,
    );
  }
  const files: PublicationPlan["files"] = [];
  let totalBytes = 0;
  for (const selectedFile of selected.slice(0, MAX_PUBLICATION_FILES)) {
    const sourcePath = path.join(repoPath, selectedFile.relativePath);
    if (profilePublicationPathEscapesRepo(repoPath, selectedFile.relativePath)) {
      blockedReasons.push(`Selected path escapes the Profile repository: ${selectedFile.relativePath}.`);
      continue;
    }
    const fileStat = await fs.lstat(sourcePath).catch(() => null);
    if (!fileStat) {
      blockedReasons.push(`Tracked source file is missing: ${selectedFile.relativePath}.`);
      continue;
    }
    if (fileStat.isSymbolicLink()) {
      blockedReasons.push(`Symbolic links cannot be published: ${selectedFile.relativePath}.`);
      continue;
    }
    if (!fileStat.isFile()) {
      blockedReasons.push(`Selected source is not a regular file: ${selectedFile.relativePath}.`);
      continue;
    }
    if (fileStat.size > MAX_PUBLICATION_FILE_BYTES) {
      blockedReasons.push(`Selected file is larger than 2 MB: ${selectedFile.relativePath}.`);
      continue;
    }
    totalBytes += fileStat.size;
    if (totalBytes > MAX_PUBLICATION_TOTAL_BYTES) {
      blockedReasons.push("Publication source is larger than 20 MB.");
      break;
    }
    const contents = await fs.readFile(sourcePath);
    if (profilePublicationContentsLookSensitive(contents)) {
      blockedReasons.push(`Potential secret detected in ${selectedFile.relativePath}. Remove it before publishing.`);
      continue;
    }
    files.push({
      sourcePath,
      relativePath: selectedFile.relativePath,
      contents,
      category: selectedFile.category,
    });
  }
  for (const missing of profilePublicationSelectionsWithoutTrackedSource(
    files.map((file) => file.relativePath),
    requiredSelections,
  )) {
    blockedReasons.push(
      `Selected ${missing.kind} "${missing.label}" has no publishable source files after safety checks.`,
    );
  }

  const manifest = {
    schema: "openpond.profileRepo.v1",
    defaultProfile: request.ref.profileId,
    profiles: {
      [request.ref.profileId]: {
        path: profileRoot || ".",
        defaultAgent: request.selection.agentIds[0] ?? "default",
        enabledAgents: request.selection.agentIds,
      },
    },
  };
  const manifestContents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestIndex = files.findIndex((file) => file.relativePath === "openpond-profile.json");
  const manifestFile = {
    sourcePath: null,
    relativePath: "openpond-profile.json",
    contents: manifestContents,
    category: "manifest",
  };
  if (manifestIndex >= 0) files[manifestIndex] = manifestFile;
  else files.push(manifestFile);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const existingTarget = await resolveExistingTarget(request);
  const sourceHash = createHash("sha256");
  sourceHash.update(JSON.stringify({
    ref: request.ref,
    selection: request.selection,
    target: request.target,
  }));
  for (const file of files) {
    sourceHash.update(file.relativePath);
    sourceHash.update("\0");
    sourceHash.update(file.contents);
    sourceHash.update("\0");
  }
  const warnings = [
    ...(excludedFiles.length > 0 ? [`${excludedFiles.length} sensitive or runtime file(s) are excluded.`] : []),
    ...(existingTarget ? ["Publishing will replace the selected repository branch with this exact preview."] : []),
    ...(request.target.visibility === "public" ? ["Anyone will be able to view every file in this preview."] : []),
  ];
  const preview: OpenPondProfilePublicationPreview = {
    sourceHash: sourceHash.digest("hex"),
    sourceRevision: entry.state.git?.head ?? null,
    clean: status.code === 0 && !status.stdout.trim(),
    blockedReasons: [...new Set(blockedReasons)],
    warnings,
    files: files.map((file) => ({
      path: file.relativePath,
      sizeBytes: file.contents.byteLength,
      category: file.category,
    })),
    excludedFiles,
    target: request.target,
    replacesExisting: Boolean(existingTarget),
  };
  return { request, preview, repoPath, files, existingTarget };
}

async function resolveExistingTarget(
  request: OpenPondProfilePublicationPreviewRequest,
): Promise<ExistingTarget | null> {
  if (request.target.provider === "github") {
    const owner = request.target.owner?.trim() || await githubLogin();
    const fullName = `${owner}/${request.target.repository}`;
    const result = await runCommand("gh", ["repo", "view", fullName, "--json", "url,defaultBranchRef"]);
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout) as { url?: string; defaultBranchRef?: { name?: string } };
    return {
      owner,
      repository: request.target.repository,
      remoteUrl: `${parsed.url ?? `https://github.com/${fullName}`}.git`,
      webUrl: parsed.url ?? `https://github.com/${fullName}`,
      defaultBranch: parsed.defaultBranchRef?.name || "master",
    };
  }
  const apps = await loadOpenPondApps({ limit: 100 });
  const existing = apps.apps.find((app) =>
    app.name === request.target.repository &&
    (!request.target.owner || app.gitOwner === request.target.owner),
  );
  if (!existing?.gitHost || !existing.gitOwner || !existing.gitRepo) return null;
  const webUrl = `https://${existing.gitHost}/${existing.gitOwner}/${existing.gitRepo}`;
  return {
    owner: existing.gitOwner,
    repository: existing.gitRepo,
    remoteUrl: `${webUrl}.git`,
    webUrl,
    defaultBranch: existing.defaultBranch ?? "master",
    appId: existing.id,
    visibility: existing.visibility === "public" ? "public" : "private",
  };
}

async function publishToGitHub(
  exportPath: string,
  request: OpenPondProfilePublicationPreviewRequest,
  existing: ExistingTarget | null,
): Promise<ExistingTarget> {
  const owner = request.target.owner?.trim() || await githubLogin();
  const fullName = `${owner}/${request.target.repository}`;
  if (!existing) {
    await runRequired("gh", [
      "repo", "create", fullName,
      request.target.visibility === "public" ? "--public" : "--private",
      "--source", exportPath,
      "--remote", "origin",
      "--push",
    ]);
  } else {
    await runRequired("gh", ["auth", "setup-git"]);
    await runRequired("git", ["remote", "add", "origin", existing.remoteUrl], exportPath);
    await runRequired("git", ["push", "--force", "origin", `HEAD:${existing.defaultBranch}`], exportPath);
    await runRequired("gh", [
      "repo", "edit", fullName,
      "--visibility", request.target.visibility,
      "--accept-visibility-change-consequences",
    ]);
  }
  return {
    owner,
    repository: request.target.repository,
    remoteUrl: `https://github.com/${fullName}.git`,
    webUrl: `https://github.com/${fullName}`,
    defaultBranch: existing?.defaultBranch ?? "master",
  };
}

async function publishToOpenPondGit(
  exportPath: string,
  request: OpenPondProfilePublicationPreviewRequest,
  existing: ExistingTarget | null,
): Promise<ExistingTarget> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) throw new Error("Sign in to OpenPond before publishing to OpenPond Git.");
  let target = existing;
  if (!target) {
    const created = await createOpenPondRepoApp({
      name: request.target.repository,
      description: `OpenPond Profile ${request.ref.profileId}`,
      repoInit: "empty",
    });
    const response = created.response;
    if (!response.gitHost || !response.gitOwner || !response.gitRepo) {
      throw new Error("OpenPond did not return a Git repository address.");
    }
    const webUrl = `https://${response.gitHost}/${response.gitOwner}/${response.gitRepo}`;
    target = {
      owner: response.gitOwner,
      repository: response.gitRepo,
      remoteUrl: response.repoUrl?.trim() || `${webUrl}.git`,
      webUrl,
      defaultBranch: response.defaultBranch || "master",
      appId: response.appId,
      visibility: "private",
    };
  }
  const tokenRemote = tokenizedRemote(target.remoteUrl, context.token);
  await runRequired("git", ["push", "--force", tokenRemote, `HEAD:${target.defaultBranch}`], exportPath, {
    GIT_TERMINAL_PROMPT: "0",
  });
  if (target.appId && target.visibility !== request.target.visibility) {
    await updateAppCodeVisibility(context.apiBaseUrl, context.token, target.appId, request.target.visibility);
  }
  return target;
}

async function githubLogin(): Promise<string> {
  const result = await runCommand("gh", ["api", "user", "--jq", ".login"]);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error("GitHub CLI is not signed in. Run `gh auth login` and try again.");
  }
  return result.stdout.trim();
}

function tokenizedRemote(remoteUrl: string, token: string): string {
  const url = new URL(remoteUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

export function profilePublicationPathIsSensitive(relativePath: string): boolean {
  return SECRET_PATH_PATTERN.test(normalizePath(relativePath));
}

export function profilePublicationContentsLookSensitive(contents: Buffer): boolean {
  if (contents.includes(0)) return false;
  const text = contents.toString("utf8");
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function profilePublicationSelectionsWithoutTrackedSource(
  trackedPaths: string[],
  selections: PublicationRequiredSelection[],
): PublicationRequiredSelection[] {
  return selections.filter((selection) =>
    !trackedPaths.some((trackedPath) => normalizePath(trackedPath).startsWith(selection.prefix)),
  );
}

export function profilePublicationPathEscapesRepo(
  repoPath: string,
  relativePath: string,
): boolean {
  const relative = path.relative(path.resolve(repoPath), path.resolve(repoPath, relativePath));
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function profilePublicationRelativePath(
  profileRoot: string,
  childPath: string,
): string {
  return normalizePath(path.posix.join(profileRoot || ".", normalizePath(childPath)));
}

async function runRequired(
  command: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<string> {
  const result = await runCommand(command, args, cwd, env);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed.`);
  return result.stdout;
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message ?? String(error),
    };
  }
}
