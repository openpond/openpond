import { createHash } from "node:crypto";
import path from "node:path";

import { parseProfileSkillMarkdown } from "../profile/profile-skills.js";
import type {
  GithubExtensionIdentity,
  GithubExtensionInstallRequest,
  OpenPondExtensionPreview,
  OpenPondExtensionSkill,
} from "./types.js";
import { GithubExtensionError } from "./types.js";

const DEFAULT_REF = "HEAD";
const MAX_EXTENSION_SKILLS = 64;
const MAX_EXTENSION_FILES = 512;
const MAX_EXTENSION_BYTES = 20 * 1024 * 1024;
const MAX_EXTENSION_FILE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 8;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const ROOT_SKILL_RESOURCE_DIRECTORIES = new Set(["agents", "assets", "references", "scripts"]);

type GithubTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

type GithubResolvedSource = {
  identity: GithubExtensionIdentity;
  requestedRef: string;
  resolvedCommit: string;
  tree: GithubTreeEntry[];
  skillPackages: GithubSkillPackage[];
  readme: GithubTreeEntry | null;
};

type GithubSkillPackage = {
  root: string;
  entry: GithubTreeEntry;
  files: GithubTreeEntry[];
};

export type GithubExtensionResolution = {
  preview: OpenPondExtensionPreview;
  files: GithubTreeEntry[];
};

export type GithubSourceClient = ReturnType<typeof createGithubSourceClient>;

export function createGithubSourceClient(options: {
  fetch?: typeof fetch;
  githubToken?: string | null;
} = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const githubToken = options.githubToken?.trim()
    || process.env.GITHUB_TOKEN?.trim()
    || process.env.GH_TOKEN?.trim()
    || null;

  return {
    async resolve(request: GithubExtensionInstallRequest): Promise<GithubExtensionResolution> {
      const source = await resolveSource(request, fetchImpl, githubToken);
      const preview = await buildPreview(source, fetchImpl, githubToken);
      return {
        preview,
        files: filesToDownload(source),
      };
    },
    async download(
      resolution: GithubExtensionResolution,
      writeFile: (relativePath: string, bytes: Uint8Array, executable: boolean) => Promise<void>,
    ): Promise<void> {
      await downloadFiles({
        resolution,
        fetchImpl,
        githubToken,
        writeFile,
      });
    },
  };
}

export function parseGithubExtensionSource(source: string): GithubExtensionIdentity {
  const trimmed = source.trim();
  let owner = "";
  let repo = "";
  if (/^(?:https?:\/\/)?github\.com\//i.test(trimmed)) {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (url.hostname.toLowerCase() !== "github.com") {
      throw invalidSource(source);
    }
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (segments.length !== 2) throw invalidSource(source);
    [owner = "", repo = ""] = segments;
  } else {
    const normalized = trimmed.replace(/^github:/i, "").replace(/^\/+|\/+$/g, "");
    const segments = normalized.split("/");
    if (segments.length !== 2) throw invalidSource(source);
    [owner = "", repo = ""] = segments;
  }
  repo = repo.replace(/\.git$/i, "");
  if (!GITHUB_REPOSITORY_PATTERN.test(owner) || !GITHUB_REPOSITORY_PATTERN.test(repo)) {
    throw invalidSource(source);
  }
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  return {
    id: `github:${normalizedOwner}/${normalizedRepo}`,
    owner: normalizedOwner,
    repo: normalizedRepo,
    repositoryUrl: `https://github.com/${normalizedOwner}/${normalizedRepo}`,
  };
}

async function resolveSource(
  request: GithubExtensionInstallRequest,
  fetchImpl: typeof fetch,
  githubToken: string | null,
): Promise<GithubResolvedSource> {
  const identity = parseGithubExtensionSource(request.source);
  const requestedRef = request.ref?.trim() || DEFAULT_REF;
  const repository = await githubJson<{
    default_branch?: string;
  }>(fetchImpl, githubToken, `/repos/${identity.owner}/${identity.repo}`);
  const resolvedRef = requestedRef === DEFAULT_REF
    ? repository.default_branch?.trim() || "main"
    : requestedRef;
  const commit = await githubJson<{
    sha?: string;
    commit?: { tree?: { sha?: string } };
  }>(
    fetchImpl,
    githubToken,
    `/repos/${identity.owner}/${identity.repo}/commits/${encodeURIComponent(resolvedRef)}`,
  );
  const resolvedCommit = commit.sha?.trim();
  const treeSha = commit.commit?.tree?.sha?.trim();
  if (!resolvedCommit || !treeSha) {
    throw new GithubExtensionError("GitHub returned an incomplete commit response.", {
      code: "github_invalid_commit",
      status: 502,
    });
  }
  const treePayload = await githubJson<{
    truncated?: boolean;
    tree?: GithubTreeEntry[];
  }>(
    fetchImpl,
    githubToken,
    `/repos/${identity.owner}/${identity.repo}/git/trees/${treeSha}?recursive=1`,
  );
  if (treePayload.truncated) {
    throw new GithubExtensionError("The GitHub repository tree is too large to install safely.", {
      code: "github_tree_truncated",
    });
  }
  const tree = (treePayload.tree ?? []).filter(validTreeEntry);
  const skillPackages = discoverSkillPackages(tree);
  if (skillPackages.length === 0) {
    throw new GithubExtensionError(
      "No skills found. Add SKILL.md at the repository root or use a standard agent skills directory.",
      { code: "extension_no_skills" },
    );
  }
  if (skillPackages.length > MAX_EXTENSION_SKILLS) {
    throw new GithubExtensionError(`Extension contains more than ${MAX_EXTENSION_SKILLS} skills.`, {
      code: "extension_too_many_skills",
    });
  }
  validateDownloadLimits(skillPackages);
  const readme = tree.find((entry) => entry.type === "blob" && /^readme(?:\.[^/]+)?$/i.test(entry.path)) ?? null;
  return { identity, requestedRef, resolvedCommit, tree, skillPackages, readme };
}

async function buildPreview(
  source: GithubResolvedSource,
  fetchImpl: typeof fetch,
  githubToken: string | null,
): Promise<OpenPondExtensionPreview> {
  const skills = await mapConcurrent(source.skillPackages, DOWNLOAD_CONCURRENCY, async (skillPackage) => {
    const contents = await downloadText(source, skillPackage.entry, fetchImpl, githubToken);
    return previewSkill(skillPackage, contents);
  });
  const duplicateNames = duplicateValues(skills.map((skill) => skill.name));
  for (const skill of skills) {
    if (!duplicateNames.has(skill.name)) continue;
    skill.validationStatus = "error";
    skill.validationMessages = [...skill.validationMessages, `Duplicate skill name: ${skill.name}`];
  }
  const validationMessages = skills.flatMap((skill) =>
    skill.validationMessages.map((message) => `${skill.relativePath}: ${message}`),
  );
  const packageFiles = filesToDownload(source);
  return {
    ...source.identity,
    source: "github",
    requestedRef: source.requestedRef,
    resolvedCommit: source.resolvedCommit,
    sourcePath: null,
    readmePath: source.readme?.path ?? null,
    packageHash: hashTree(packageFiles),
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    validationStatus: validationMessages.length === 0 ? "valid" : "error",
    validationMessages,
  };
}

function previewSkill(skillPackage: GithubSkillPackage, contents: string): OpenPondExtensionSkill {
  const parsed = parseProfileSkillMarkdown(contents);
  const directoryName = skillPackage.root === "."
    ? null
    : path.posix.basename(skillPackage.root);
  const name = parsed.name ?? directoryName ?? "invalid-skill";
  const messages = [...parsed.messages];
  if (!SKILL_NAME_PATTERN.test(name)) messages.push("Skill name must be lowercase kebab-case.");
  if (directoryName && name !== directoryName) {
    messages.push(`Skill name must match its directory name (${directoryName}).`);
  }
  const resourceFiles = skillPackage.files
    .filter((file) => file.path !== skillPackage.entry.path)
    .map((file) => relativeSkillPath(skillPackage.root, file.path))
    .sort();
  return {
    name,
    description: parsed.description ?? "",
    relativePath: skillPackage.root === "." ? "SKILL.md" : `${skillPackage.root}/SKILL.md`,
    sourcePath: "",
    charCount: contents.length,
    sourceHash: createHash("sha256").update(contents).digest("hex"),
    resourceFiles,
    validationStatus: messages.length === 0 ? "valid" : "error",
    validationMessages: [...new Set(messages)],
  };
}

function discoverSkillPackages(tree: GithubTreeEntry[]): GithubSkillPackage[] {
  const entries: Array<{ root: string; entry: GithubTreeEntry }> = [];
  const rootEntry = tree.find((entry) => entry.type === "blob" && entry.path === "SKILL.md");
  if (rootEntry) entries.push({ root: ".", entry: rootEntry });
  const skillEntries = tree.filter((entry) => entry.type === "blob" && entry.path.endsWith("/SKILL.md"));
  const standardEntries = skillEntries.filter((entry) => isStandardAgentSkillsPath(entry.path));
  const discoveredEntries = standardEntries.length > 0 ? standardEntries : skillEntries;
  const roots = new Set(discoveredEntries.map((entry) => path.posix.dirname(entry.path)));
  for (const entry of discoveredEntries) {
    const root = path.posix.dirname(entry.path);
    if ([...roots].some((candidate) => candidate !== root && root.startsWith(`${candidate}/`))) continue;
    entries.push({ root, entry });
  }
  return entries.map(({ root, entry }) => {
    const files = tree.filter((candidate) => {
      if (candidate.type !== "blob") return false;
      if (root !== ".") return candidate.path.startsWith(`${root}/`);
      if (candidate.path === "SKILL.md") return true;
      const firstSegment = candidate.path.split("/", 1)[0] ?? "";
      return ROOT_SKILL_RESOURCE_DIRECTORIES.has(firstSegment);
    });
    const unsafe = tree.find((candidate) =>
      candidate.type !== "blob"
      && candidate.type !== "tree"
      && (root === "."
        ? candidate.path === "SKILL.md" || ROOT_SKILL_RESOURCE_DIRECTORIES.has(candidate.path.split("/", 1)[0] ?? "")
        : candidate.path.startsWith(`${root}/`)),
    );
    const symlink = files.find((candidate) => candidate.mode === "120000");
    if (unsafe || symlink) {
      throw new GithubExtensionError(`Skill package ${root} contains a symlink or submodule.`, {
        code: "extension_unsafe_entry",
      });
    }
    return { root, entry, files };
  });
}

function isStandardAgentSkillsPath(skillPath: string): boolean {
  const segments = skillPath.split("/");
  if (segments.at(-1) !== "SKILL.md") return false;
  const skillDirectorySegments = segments.slice(0, -1);
  if (skillDirectorySegments.length < 2) return false;
  const skillsIndex = skillDirectorySegments.lastIndexOf("skills");
  if (skillsIndex < 0 || skillsIndex > 2) return false;
  const containerPrefix = skillDirectorySegments.slice(0, skillsIndex);
  const nestedSkillPath = skillDirectorySegments.slice(skillsIndex + 1);
  if (nestedSkillPath.length < 1 || nestedSkillPath.length > 2) return false;
  if (skillsIndex === 0) return true;
  const first = containerPrefix[0] ?? "";
  return first.startsWith(".") || first === "agent" || first === "data";
}

function filesToDownload(source: GithubResolvedSource): GithubTreeEntry[] {
  const byPath = new Map<string, GithubTreeEntry>();
  if (source.readme) byPath.set(source.readme.path, source.readme);
  for (const skillPackage of source.skillPackages) {
    for (const file of skillPackage.files) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function downloadFiles(input: {
  resolution: GithubExtensionResolution;
  fetchImpl: typeof fetch;
  githubToken: string | null;
  writeFile: (relativePath: string, bytes: Uint8Array, executable: boolean) => Promise<void>;
}): Promise<void> {
  let downloadedBytes = 0;
  await mapConcurrent(input.resolution.files, DOWNLOAD_CONCURRENCY, async (file) => {
    const bytes = await downloadBytes({
      owner: input.resolution.preview.owner,
      repo: input.resolution.preview.repo,
      commit: input.resolution.preview.resolvedCommit,
      file,
      fetchImpl: input.fetchImpl,
      githubToken: input.githubToken,
    });
    downloadedBytes += bytes.byteLength;
    if (downloadedBytes > MAX_EXTENSION_BYTES) {
      throw new GithubExtensionError("Extension download exceeds the maximum allowed size.", {
        code: "extension_too_large",
      });
    }
    await input.writeFile(file.path, bytes, file.mode === "100755");
  });
}

async function downloadText(
  source: GithubResolvedSource,
  file: GithubTreeEntry,
  fetchImpl: typeof fetch,
  githubToken: string | null,
): Promise<string> {
  const bytes = await downloadBytes({
    owner: source.identity.owner,
    repo: source.identity.repo,
    commit: source.resolvedCommit,
    file,
    fetchImpl,
    githubToken,
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function downloadBytes(input: {
  owner: string;
  repo: string;
  commit: string;
  file: GithubTreeEntry;
  fetchImpl: typeof fetch;
  githubToken: string | null;
}): Promise<Uint8Array> {
  const encodedPath = input.file.path.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${input.owner}/${input.repo}/${input.commit}/${encodedPath}`;
  const response = await input.fetchImpl(url, {
    headers: githubHeaders(input.githubToken, "application/vnd.github.raw"),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new GithubExtensionError(`GitHub file download failed (${response.status}): ${input.file.path}`, {
      code: "github_download_failed",
      status: response.status,
    });
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_EXTENSION_FILE_BYTES) {
    throw new GithubExtensionError(`Extension file is too large: ${input.file.path}`, {
      code: "extension_file_too_large",
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_EXTENSION_FILE_BYTES) {
    throw new GithubExtensionError(`Extension file is too large: ${input.file.path}`, {
      code: "extension_file_too_large",
    });
  }
  return bytes;
}

async function githubJson<T>(
  fetchImpl: typeof fetch,
  githubToken: string | null,
  pathname: string,
): Promise<T> {
  const response = await fetchImpl(`https://api.github.com${pathname}`, {
    headers: githubHeaders(githubToken, "application/vnd.github+json"),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null) as { message?: unknown } | null;
    const detail = typeof details?.message === "string" ? `: ${details.message}` : "";
    throw new GithubExtensionError(`GitHub request failed (${response.status})${detail}`, {
      code: response.status === 404 ? "github_repository_not_found" : "github_request_failed",
      status: response.status,
    });
  }
  return await response.json() as T;
}

function githubHeaders(token: string | null, accept: string): Headers {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": "openpond-extension-installer",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function validateDownloadLimits(skillPackages: GithubSkillPackage[]): void {
  const files = new Map<string, GithubTreeEntry>();
  for (const skillPackage of skillPackages) {
    for (const file of skillPackage.files) files.set(file.path, file);
  }
  if (files.size > MAX_EXTENSION_FILES) {
    throw new GithubExtensionError(`Extension contains more than ${MAX_EXTENSION_FILES} skill files.`, {
      code: "extension_too_many_files",
    });
  }
  let totalBytes = 0;
  for (const file of files.values()) {
    if ((file.size ?? 0) > MAX_EXTENSION_FILE_BYTES) {
      throw new GithubExtensionError(`Extension file is too large: ${file.path}`, {
        code: "extension_file_too_large",
      });
    }
    totalBytes += file.size ?? 0;
  }
  if (totalBytes > MAX_EXTENSION_BYTES) {
    throw new GithubExtensionError("Extension exceeds the maximum allowed size.", {
      code: "extension_too_large",
    });
  }
}

function validTreeEntry(value: unknown): value is GithubTreeEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<GithubTreeEntry>;
  return typeof entry.path === "string"
    && !entry.path.startsWith("/")
    && !entry.path.split("/").includes("..")
    && typeof entry.mode === "string"
    && (entry.type === "blob" || entry.type === "tree" || entry.type === "commit")
    && typeof entry.sha === "string";
}

function hashTree(files: GithubTreeEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.sha}\0${file.size ?? ""}\n`);
  return hash.digest("hex");
}

function relativeSkillPath(root: string, filePath: string): string {
  return root === "." ? filePath : filePath.slice(root.length + 1);
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function invalidSource(source: string): GithubExtensionError {
  return new GithubExtensionError(
    `Invalid GitHub extension source: ${source}. Use owner/repo or https://github.com/owner/repo.`,
    { code: "github_invalid_source" },
  );
}
