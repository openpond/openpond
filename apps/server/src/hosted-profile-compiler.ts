import { mkdir } from "node:fs/promises";
import path from "node:path";

import { loadOpenPondProfileStateFromSource } from "@openpond/cloud";

import { compileProfileHarnessSource, materializeLocalHarnessRelease } from "./harness/local-harness-workspace-service.js";

export type HostedProfileCompileRequest = {
  repoPath: string;
  profileId: string;
  repositoryId: string;
  sourceRevision: string;
  workspaceId: string;
  outputDir: string;
};

/** Compile a host-pinned source tree without selecting a user Harness or
 * opening a mutable SQLite owner store. The caller must verify Git authority. */
export async function compileHostedProfileRelease(input: HostedProfileCompileRequest) {
  if (!path.isAbsolute(input.repoPath) || !path.isAbsolute(input.outputDir) ||
      !/^[a-f0-9]{40,64}$/.test(input.sourceRevision) ||
      !input.workspaceId.trim() || !input.repositoryId.trim() || !input.profileId.trim()) {
    throw new Error("Hosted Profile compile request is invalid.");
  }
  const profile = await loadOpenPondProfileStateFromSource({
    repoPath: input.repoPath, profileId: input.profileId,
  });
  if (profile.error || profile.mode !== "local" || profile.activeProfile !== input.profileId ||
      !profile.sourcePath || !path.resolve(profile.sourcePath).startsWith(`${path.resolve(input.repoPath)}${path.sep}`)) {
    throw new Error("Hosted Profile source is unavailable.");
  }
  await mkdir(input.outputDir, { recursive: true });
  const compiled = await compileProfileHarnessSource({
    storeDir: input.outputDir, workspaceId: input.workspaceId,
    name: input.profileId, profile, sourceRevision: input.sourceRevision,
    repositoryId: input.repositoryId,
  });
  const provenance = compiled.harnessRelease.metadata.profile;
  if (!provenance || typeof provenance !== "object" ||
      (provenance as Record<string, unknown>).id !== input.profileId ||
      (provenance as Record<string, unknown>).sourceRevision !== input.sourceRevision ||
      (provenance as Record<string, unknown>).repositoryId !== input.repositoryId) {
    throw new Error("Hosted Profile release provenance is invalid.");
  }
  const record = await materializeLocalHarnessRelease({
    storeDir: input.outputDir, workspaceId: input.workspaceId, compiled,
    createdAt: new Date().toISOString(),
  });
  return {
    workspaceId: input.workspaceId,
    sourceRevision: record.sourceRevision,
    harnessRelease: record.harnessRelease,
    agentSnapshot: record.agentSnapshot,
    bundlePath: record.bundlePath,
  };
}

export async function runHostedProfileCompilerCli(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0]!.length > 16_000 || !/^[A-Za-z0-9_-]+$/.test(args[0]!)) {
    throw new Error("Hosted Profile compile argument is invalid.");
  }
  const input = JSON.parse(Buffer.from(args[0]!, "base64url").toString("utf8")) as HostedProfileCompileRequest;
  const result = await compileHostedProfileRelease(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
