import { promises as fs } from "node:fs";
import path from "node:path";

import { parseProfileSkillMarkdown } from "@openpond/cloud";
import type { HarnessWorkspace, OpenPondProfileSkill } from "@openpond/contracts";
import { sha256 } from "@openpond/evals";

import type { ProfileSkillReadResult } from "../openpond/model-tool-registry.js";
import type { ProfileSkillRuntime } from "../runtime/hosted-turn/native-tools-runtime.js";
import type { SqliteStore } from "../store/store.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-workspaces.js";
import {
  DESKTOP_PERSONAL_HARNESS_OWNER_ID,
  resolveSelectedLocalHarnessRelease,
} from "./local-harness-selection.js";

export type SelectedLocalHarnessRuntime = {
  workspace: HarnessWorkspace;
  release: LocalHarnessReleaseRecord;
  skillRuntime: ProfileSkillRuntime;
};

export async function loadSelectedLocalHarnessSkillRuntime(
  store: SqliteStore,
): Promise<ProfileSkillRuntime | null> {
  return (await loadSelectedLocalHarnessRuntime(store))?.skillRuntime ?? null;
}

export async function loadSelectedLocalHarnessRuntime(
  store: SqliteStore,
): Promise<SelectedLocalHarnessRuntime | null> {
  const release = await resolveSelectedLocalHarnessRelease(store);
  if (!release) return null;
  const workspace = await store.getSelectedHarnessWorkspace({
    ownerKind: "personal",
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
  });
  if (!workspace || workspace.id !== release.workspaceId) {
    throw new Error("Selected Harness workspace changed while its release was being admitted.");
  }
  return loadLocalHarnessRuntimeFromRelease({ workspace, release });
}

export async function loadLocalHarnessRuntimeFromRelease(input: {
  workspace: HarnessWorkspace;
  release: LocalHarnessReleaseRecord;
}): Promise<SelectedLocalHarnessRuntime> {
  const { workspace, release } = input;
  if (release.workspaceId !== workspace.id) {
    throw new Error("Harness release does not belong to the requested workspace.");
  }
  const sourceRoot = path.join(release.bundlePath, "source");
  const skills: OpenPondProfileSkill[] = [];
  const readers = new Map<string, () => Promise<ProfileSkillReadResult>>();

  for (const asset of release.agentSnapshot.skills) {
    const markdown = await readVerifiedAsset(sourceRoot, asset.path, asset.contentHash);
    const parsed = parseProfileSkillMarkdown(markdown);
    if (!parsed.name || !parsed.description || parsed.messages.length > 0) {
      throw new Error(
        `Released Harness Skill ${asset.path} is invalid: ${parsed.messages.join(" ") || "missing name or description"}`,
      );
    }
    if (readers.has(parsed.name)) throw new Error(`Released Harness has duplicate Skill ${parsed.name}.`);
    const packagePrefix = `${path.posix.dirname(asset.path)}/`;
    const resourceFiles = release.harnessRelease.files
      .filter((candidate) => candidate.path.startsWith(packagePrefix) && candidate.path !== asset.path)
      .map((candidate) => candidate.path.slice(packagePrefix.length))
      .sort();
    const skill: OpenPondProfileSkill = {
      name: parsed.name,
      description: parsed.description,
      path: asset.path,
      scope: "profile",
      enabled: true,
      sourcePath: sourceRoot,
      charCount: markdown.length,
      sourceHash: asset.contentHash,
      validationStatus: "valid",
      validationMessages: [],
      resourceFiles,
    };
    skills.push(skill);
    readers.set(skill.name, async () => {
      const currentMarkdown = await readVerifiedAsset(sourceRoot, asset.path, asset.contentHash);
      const current = parseProfileSkillMarkdown(currentMarkdown);
      if (!current.name || !current.description || current.messages.length > 0) {
        throw new Error(`Released Harness Skill ${asset.path} failed validation while loading.`);
      }
      return {
        name: current.name,
        description: current.description,
        body: current.body,
        path: asset.path,
        sourceHash: asset.contentHash,
        charCount: currentMarkdown.length,
        packagePath: path.join(sourceRoot, ...path.posix.dirname(asset.path).split("/")),
        resourceFiles,
      };
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  const skillRuntime: ProfileSkillRuntime = {
    profileSourcePath: sourceRoot,
    skills,
    readSkill: readers.size > 0
      ? async (name) => {
          const read = readers.get(name);
          if (!read) throw new Error(`Released Harness Skill not found: ${name}`);
          return read();
        }
      : null,
  };
  return { workspace, release, skillRuntime };
}

async function readVerifiedAsset(
  sourceRoot: string,
  relativePath: string,
  expectedHash: string,
): Promise<string> {
  const absolute = path.resolve(sourceRoot, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(sourceRoot), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Released Harness asset escapes its bundle: ${relativePath}`);
  }
  const bytes = await fs.readFile(absolute);
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(`Released Harness asset ${relativePath} is ${actualHash}; expected ${expectedHash}.`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
