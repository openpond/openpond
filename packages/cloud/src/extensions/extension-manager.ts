import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  openPondConfigDirectory,
  updatePrivateJsonFile,
} from "../private-json-file.js";
import {
  createGithubSourceClient,
  parseGithubExtensionSource,
  type GithubExtensionResolution,
} from "./github-source.js";
import { parseProfileSkillMarkdown } from "../profile/profile-skills.js";
import type {
  GithubExtensionInstallRequest,
  GithubExtensionManagerOptions,
  GithubExtensionUpdateAllResult,
  OpenPondExtension,
  OpenPondExtensionCatalog,
  OpenPondExtensionPreview,
  OpenPondExtensionSkillReadResult,
} from "./types.js";
import { GithubExtensionError } from "./types.js";

const REGISTRY_SCHEMA_VERSION = 1;
const OPERATION_LOCK_STALE_MS = 2 * 60 * 1000;
const OPERATION_LOCK_TIMEOUT_MS = 15_000;

type ExtensionRegistry = {
  schemaVersion: 1;
  updatedAt: string | null;
  extensions: OpenPondExtension[];
};

export type GithubExtensionManager = ReturnType<typeof createGithubExtensionManager>;

export function createGithubExtensionManager(options: GithubExtensionManagerOptions = {}) {
  const rootPath = path.resolve(options.rootPath ?? path.join(openPondConfigDirectory(), "extensions"));
  const registryPath = path.join(rootPath, "registry.json");
  const github = createGithubSourceClient({
    fetch: options.fetch,
    githubToken: options.githubToken,
  });
  const now = options.now ?? (() => new Date());

  async function list(): Promise<OpenPondExtensionCatalog> {
    try {
      const registry = await readRegistry(registryPath);
      const extensions = await Promise.all(registry.extensions.map((extension) => hydrateExtension(rootPath, extension)));
      markInstalledSkillConflicts(extensions, await reservedSkillNames(options.reservedSkillNames));
      return {
        rootPath,
        registryPath,
        extensions: extensions.sort(extensionSort),
        error: null,
      };
    } catch (error) {
      return {
        rootPath,
        registryPath,
        extensions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function preview(request: GithubExtensionInstallRequest): Promise<OpenPondExtensionPreview> {
    const resolution = await github.resolve(request);
    const registry = await readRegistry(registryPath);
    const existing = registry.extensions.find((extension) => extension.id === resolution.preview.id) ?? null;
    assertSkillNamesAvailable(
      resolution.preview,
      registry.extensions.filter((extension) => extension.id !== existing?.id),
      await reservedSkillNames(options.reservedSkillNames),
    );
    return resolution.preview;
  }

  async function add(request: GithubExtensionInstallRequest): Promise<OpenPondExtension> {
    const identity = parseGithubExtensionSource(request.source);
    return withExtensionLock(rootPath, identity.id, async () => {
      const registry = await readRegistry(registryPath);
      if (registry.extensions.some((extension) => extension.id === identity.id)) {
        throw new GithubExtensionError(`${identity.owner}/${identity.repo} is already installed.`, {
          code: "extension_already_installed",
          status: 409,
        });
      }
      const resolution = await github.resolve(request);
      assertInstallable(resolution.preview);
      assertSkillNamesAvailable(
        resolution.preview,
        registry.extensions,
        await reservedSkillNames(options.reservedSkillNames),
      );
      const timestamp = now().toISOString();
      const installed = await materializeExtension({
        rootPath,
        resolution,
        installedAt: timestamp,
        updatedAt: timestamp,
        github,
      });
      try {
        const reserved = await reservedSkillNames(options.reservedSkillNames);
        await writeRegistry(registryPath, now, (current) => ({
          ...current,
          extensions: appendInstalledExtension(current, installed, reserved),
        }));
        await finalizeMaterialization(rootPath, installed.id);
        return installed;
      } catch (error) {
        await rollbackMaterialization(rootPath, installed.id);
        throw error;
      }
    });
  }

  async function update(request: GithubExtensionInstallRequest): Promise<OpenPondExtension> {
    const identity = parseGithubExtensionSource(request.source);
    return withExtensionLock(rootPath, identity.id, async () => {
      const registry = await readRegistry(registryPath);
      const existing = requireInstalled(registry, identity.id);
      const resolution = await github.resolve({
        source: existing.repositoryUrl,
        ref: request.ref?.trim() || existing.requestedRef,
      });
      assertInstallable(resolution.preview);
      assertSkillNamesAvailable(
        resolution.preview,
        registry.extensions.filter((extension) => extension.id !== existing.id),
        await reservedSkillNames(options.reservedSkillNames),
      );
      if (
        existing.resolvedCommit === resolution.preview.resolvedCommit
        && existing.packageHash === resolution.preview.packageHash
        && existing.requestedRef === resolution.preview.requestedRef
      ) {
        return hydrateExtension(rootPath, existing);
      }
      const installed = await materializeExtension({
        rootPath,
        resolution,
        installedAt: existing.installedAt,
        updatedAt: now().toISOString(),
        github,
      });
      try {
        const reserved = await reservedSkillNames(options.reservedSkillNames);
        await writeRegistry(registryPath, now, (current) => ({
          ...current,
          extensions: replaceInstalledExtension(current, installed, reserved),
        }));
        await finalizeMaterialization(rootPath, installed.id);
        return installed;
      } catch (error) {
        await rollbackMaterialization(rootPath, installed.id);
        throw error;
      }
    });
  }

  async function updateAll(): Promise<GithubExtensionUpdateAllResult> {
    const catalog = await list();
    if (catalog.error) throw new GithubExtensionError(catalog.error, { code: "extension_registry_error" });
    const result: GithubExtensionUpdateAllResult = { updated: [], unchanged: [], failed: [] };
    for (const extension of catalog.extensions) {
      try {
        const next = await update({ source: extension.repositoryUrl, ref: extension.requestedRef });
        if (next.resolvedCommit === extension.resolvedCommit && next.packageHash === extension.packageHash) {
          result.unchanged.push(next);
        } else {
          result.updated.push(next);
        }
      } catch (error) {
        result.failed.push({
          id: extension.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async function inspect(source: string): Promise<OpenPondExtension> {
    const identity = parseGithubExtensionSource(source);
    const registry = await readRegistry(registryPath);
    return hydrateExtension(rootPath, requireInstalled(registry, identity.id));
  }

  async function remove(source: string): Promise<OpenPondExtension> {
    const identity = parseGithubExtensionSource(source);
    return withExtensionLock(rootPath, identity.id, async () => {
      const registry = await readRegistry(registryPath);
      const existing = requireInstalled(registry, identity.id);
      const target = extensionDirectory(rootPath, identity.owner, identity.repo);
      const trash = `${target}.${randomUUID()}.remove`;
      if (existsSync(target)) await rename(target, trash);
      try {
        await writeRegistry(registryPath, now, (current) => ({
          ...current,
          extensions: current.extensions.filter((extension) => extension.id !== existing.id),
        }));
        await rm(trash, { recursive: true, force: true });
        return existing;
      } catch (error) {
        if (existsSync(trash) && !existsSync(target)) await rename(trash, target);
        throw error;
      }
    });
  }

  async function readSkill(nameInput: string): Promise<OpenPondExtensionSkillReadResult> {
    const name = nameInput.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new GithubExtensionError("Extension skill name must be lowercase kebab-case.", {
        code: "extension_skill_invalid_name",
      });
    }
    const catalog = await list();
    if (catalog.error) {
      throw new GithubExtensionError(catalog.error, { code: "extension_registry_error" });
    }
    const matches = catalog.extensions.flatMap((extension) =>
      extension.skills
        .filter((skill) => skill.name === name)
        .map((skill) => ({ extension, skill })),
    );
    if (matches.length === 0) {
      throw new GithubExtensionError(`Extension skill not found: ${name}`, {
        code: "extension_skill_not_found",
        status: 404,
      });
    }
    if (matches.length > 1) {
      throw new GithubExtensionError(`Extension skill name is ambiguous: ${name}`, {
        code: "extension_skill_conflict",
        status: 409,
      });
    }
    const match = matches[0]!;
    if (
      match.extension.validationStatus !== "valid"
      || match.skill.validationStatus !== "valid"
    ) {
      throw new GithubExtensionError(`Extension skill ${name} is not valid.`, {
        code: "extension_skill_invalid",
      });
    }
    const absolutePath = safeDestination(match.extension.sourcePath, match.skill.relativePath);
    const markdown = await readFile(absolutePath, "utf8");
    const sourceHash = createHash("sha256").update(markdown).digest("hex");
    if (sourceHash !== match.skill.sourceHash) {
      throw new GithubExtensionError(
        `Extension skill ${name} changed on disk. Update or reinstall its extension before using it.`,
        { code: "extension_skill_modified" },
      );
    }
    const parsed = parseProfileSkillMarkdown(markdown);
    if (parsed.messages.length > 0 || parsed.name !== name || !parsed.description) {
      throw new GithubExtensionError(
        `Extension skill ${name} is not valid. ${parsed.messages.join(" ")}`.trim(),
        { code: "extension_skill_invalid" },
      );
    }
    return {
      name,
      description: parsed.description,
      body: parsed.body,
      path: match.skill.relativePath,
      sourcePath: match.extension.sourcePath,
      sourceHash,
      charCount: markdown.length,
      packagePath: path.dirname(absolutePath),
      resourceFiles: match.skill.resourceFiles,
    };
  }

  return { rootPath, registryPath, list, preview, add, update, updateAll, inspect, remove, readSkill };
}

async function materializeExtension(input: {
  rootPath: string;
  resolution: GithubExtensionResolution;
  installedAt: string;
  updatedAt: string;
  github: ReturnType<typeof createGithubSourceClient>;
}): Promise<OpenPondExtension> {
  const preview = input.resolution.preview;
  const target = extensionDirectory(input.rootPath, preview.owner, preview.repo);
  const temporary = `${target}.${randomUUID()}.install`;
  const backup = backupDirectory(input.rootPath, preview.id);
  const current = path.join(temporary, "current");
  await rm(temporary, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(current, { recursive: true, mode: 0o700 });
  try {
    await input.github.download(input.resolution, async (relativePath, bytes, executable) => {
      const destination = safeDestination(current, relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: executable ? 0o700 : 0o600 });
    });
    const extension = installedExtension(preview, target, input.installedAt, input.updatedAt);
    await writeFile(
      path.join(temporary, "extension.json"),
      `${JSON.stringify(extension, null, 2)}\n`,
      { mode: 0o600 },
    );
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) await rename(target, backup);
    await rename(temporary, target);
    return extension;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(target)) await rename(backup, target);
    throw error;
  }
}

function installedExtension(
  preview: OpenPondExtensionPreview,
  target: string,
  installedAt: string,
  updatedAt: string,
): OpenPondExtension {
  const sourcePath = path.join(target, "current");
  return {
    ...preview,
    sourcePath,
    readmePath: preview.readmePath ? path.join(sourcePath, preview.readmePath) : null,
    installedAt,
    updatedAt,
    skills: preview.skills.map((skill) => ({
      ...skill,
      sourcePath: path.join(sourcePath, skill.relativePath),
    })),
  };
}

async function finalizeMaterialization(rootPath: string, id: string): Promise<void> {
  await rm(backupDirectory(rootPath, id), { recursive: true, force: true });
}

async function rollbackMaterialization(rootPath: string, id: string): Promise<void> {
  const identity = parseGithubExtensionSource(id.replace(/^github:/, ""));
  const target = extensionDirectory(rootPath, identity.owner, identity.repo);
  const backup = backupDirectory(rootPath, id);
  await rm(target, { recursive: true, force: true });
  if (existsSync(backup)) await rename(backup, target);
}

async function hydrateExtension(rootPath: string, extension: OpenPondExtension): Promise<OpenPondExtension> {
  const target = extensionDirectory(rootPath, extension.owner, extension.repo);
  const sourcePath = path.join(target, "current");
  const present = (await stat(path.join(target, "extension.json")).catch(() => null))?.isFile() ?? false;
  const validationMessages = extension.validationMessages.filter((message) => message !== "Installed files are missing.");
  if (!present) validationMessages.push("Installed files are missing.");
  return {
    ...extension,
    sourcePath,
    readmePath: extension.readmePath ? path.join(sourcePath, path.basename(extension.readmePath)) : null,
    skills: extension.skills.map((skill) => ({
      ...skill,
      sourcePath: path.join(sourcePath, skill.relativePath),
    })),
    validationStatus: validationMessages.length === 0 ? "valid" : "error",
    validationMessages,
  };
}

function assertInstallable(preview: OpenPondExtensionPreview): void {
  if (preview.validationStatus === "valid") return;
  throw new GithubExtensionError(
    `Extension contains invalid skills: ${preview.validationMessages.join(" ")}`,
    { code: "extension_invalid" },
  );
}

function assertSkillNamesAvailable(
  preview: Pick<OpenPondExtensionPreview, "skills">,
  installed: OpenPondExtension[],
  reserved: string[],
): void {
  const owners = new Map<string, string>();
  for (const name of reserved) owners.set(name, "a shipped OpenPond skill");
  for (const extension of installed) {
    for (const skill of extension.skills) owners.set(skill.name, extension.id);
  }
  const conflicts = preview.skills
    .map((skill) => ({ name: skill.name, owner: owners.get(skill.name) }))
    .filter((entry): entry is { name: string; owner: string } => Boolean(entry.owner));
  if (conflicts.length === 0) return;
  throw new GithubExtensionError(
    `Skill name conflict: ${conflicts.map((entry) => `${entry.name} (${entry.owner})`).join(", ")}.`,
    { code: "extension_skill_conflict", status: 409 },
  );
}

function appendInstalledExtension(
  registry: ExtensionRegistry,
  installed: OpenPondExtension,
  reserved: string[],
): OpenPondExtension[] {
  if (registry.extensions.some((extension) => extension.id === installed.id)) {
    throw new GithubExtensionError(`${installed.owner}/${installed.repo} is already installed.`, {
      code: "extension_already_installed",
      status: 409,
    });
  }
  assertSkillNamesAvailable(installed, registry.extensions, reserved);
  return [...registry.extensions, installed].sort(extensionSort);
}

function replaceInstalledExtension(
  registry: ExtensionRegistry,
  installed: OpenPondExtension,
  reserved: string[],
): OpenPondExtension[] {
  requireInstalled(registry, installed.id);
  assertSkillNamesAvailable(
    installed,
    registry.extensions.filter((extension) => extension.id !== installed.id),
    reserved,
  );
  return registry.extensions
    .map((extension) => extension.id === installed.id ? installed : extension)
    .sort(extensionSort);
}

function markInstalledSkillConflicts(extensions: OpenPondExtension[], reserved: string[]): void {
  const owners = new Map<string, string>();
  for (const name of reserved) owners.set(name, "built-in");
  for (const extension of extensions) {
    for (const skill of extension.skills) {
      const owner = owners.get(skill.name);
      if (!owner) {
        owners.set(skill.name, extension.id);
        continue;
      }
      const message = `Skill name conflicts with ${owner}: ${skill.name}`;
      skill.validationStatus = "error";
      skill.validationMessages = [...new Set([...skill.validationMessages, message])];
      extension.validationStatus = "error";
      extension.validationMessages = [...new Set([...extension.validationMessages, message])];
    }
  }
}

async function reservedSkillNames(
  source: GithubExtensionManagerOptions["reservedSkillNames"],
): Promise<string[]> {
  const values = typeof source === "function" ? await source() : source ?? [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requireInstalled(registry: ExtensionRegistry, id: string): OpenPondExtension {
  const extension = registry.extensions.find((candidate) => candidate.id === id);
  if (extension) return extension;
  throw new GithubExtensionError(`${id.replace(/^github:/, "")} is not installed.`, {
    code: "extension_not_installed",
    status: 404,
  });
}

async function readRegistry(registryPath: string): Promise<ExtensionRegistry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8")) as Partial<ExtensionRegistry>;
    if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.extensions)) {
      throw new Error("Extension registry has an unsupported format.");
    }
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      extensions: parsed.extensions.filter(isStoredExtension),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function writeRegistry(
  registryPath: string,
  now: () => Date,
  update: (registry: ExtensionRegistry) => ExtensionRegistry,
): Promise<void> {
  await updatePrivateJsonFile<ExtensionRegistry>(registryPath, emptyRegistry, (current) => ({
    ...update(normalizeRegistry(current)),
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    updatedAt: now().toISOString(),
  }));
}

function normalizeRegistry(value: ExtensionRegistry): ExtensionRegistry {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
    extensions: Array.isArray(value?.extensions) ? value.extensions.filter(isStoredExtension) : [],
  };
}

function emptyRegistry(): ExtensionRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: null, extensions: [] };
}

function isStoredExtension(value: unknown): value is OpenPondExtension {
  if (!value || typeof value !== "object") return false;
  const extension = value as Partial<OpenPondExtension>;
  return extension.source === "github"
    && typeof extension.id === "string"
    && typeof extension.owner === "string"
    && typeof extension.repo === "string"
    && typeof extension.repositoryUrl === "string"
    && typeof extension.requestedRef === "string"
    && typeof extension.resolvedCommit === "string"
    && Array.isArray(extension.skills);
}

function safeDestination(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new GithubExtensionError(`Unsafe extension path: ${relativePath}`, {
      code: "extension_unsafe_path",
    });
  }
  const destination = path.resolve(root, ...relativePath.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(prefix)) {
    throw new GithubExtensionError(`Unsafe extension path: ${relativePath}`, {
      code: "extension_unsafe_path",
    });
  }
  return destination;
}

function extensionDirectory(rootPath: string, owner: string, repo: string): string {
  return path.join(rootPath, "github", owner, repo);
}

function backupDirectory(rootPath: string, id: string): string {
  const identity = parseGithubExtensionSource(id.replace(/^github:/, ""));
  return `${extensionDirectory(rootPath, identity.owner, identity.repo)}.previous`;
}

async function withExtensionLock<T>(rootPath: string, id: string, operation: () => Promise<T>): Promise<T> {
  const safeId = id.replace(/[^a-z0-9.-]+/gi, "-");
  const lockPath = path.join(rootPath, ".locks", `${safeId}.lock`);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + OPERATION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > OPERATION_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new GithubExtensionError(`Timed out waiting for extension operation: ${id}`, {
          code: "extension_operation_busy",
          status: 409,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function extensionSort(left: OpenPondExtension, right: OpenPondExtension): number {
  return left.id.localeCompare(right.id);
}
