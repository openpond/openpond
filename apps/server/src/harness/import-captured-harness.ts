import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { HarnessWorkspaceSchema } from "@openpond/contracts";
import { harnessSourcePackageFiles, validateHarnessSourcePackage } from "@openpond/harness";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { LocalHarnessReleaseRecordSchema } from "../store/store-harness-release-record.js";
import { DESKTOP_PERSONAL_HARNESS_OWNER_ID } from "./local-harness-selection.js";
import { loadLocalHarnessRuntimeFromRelease } from "./local-harness-skill-runtime.js";

/** Admit captured bytes without recompiling them or resolving the user's current draft. */
export async function importCapturedHarness(input: {
  store: SqliteStore;
  storeDir: string;
  source: unknown;
}) {
  const source = validateHarnessSourcePackage(input.source);
  const files = harnessSourcePackageFiles(source);
  const program = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get(source.harnessRelease.program.path)));
  if (!z.object({ runtimeProtocol: z.literal("openpond.agent-runtime.v1") }).strict().safeParse(program).success
    || source.harnessRelease.metadata.runtimeProtocol !== "openpond.agent-runtime.v1") {
    throw new Error("Captured Harness requires a different execution adapter than Work.");
  }
  if (source.harnessRelease.files.some(asset => asset.visibility !== "policy")) {
    throw new Error("Work Harness admission requires a policy-only release; private assets need a separate host boundary.");
  }
  const hash = source.harnessRelease.contentHash;
  const existing = await input.store.getHarnessReleaseRecord(hash);
  if (existing) {
    const workspace = await input.store.getHarnessWorkspace(existing.workspaceId);
    if (!workspace || workspace.metadata.capturedSourcePackageHash !== source.contentHash) {
      throw new Error("Captured Harness admission conflicts with an existing release registration.");
    }
    return loadLocalHarnessRuntimeFromRelease({ workspace, release: existing });
  }
  const timestamp = new Date().toISOString();
  const workspaceId = `captured-${hash}`;
  const parent = path.join(input.storeDir, "training", "work-harnesses");
  await mkdir(parent, { recursive: true });
  const root = path.join(parent, `${hash}-${randomUUID()}`);
  const temporary = `${root}.importing`;
  await mkdir(path.join(temporary, "source"), { recursive: true });
  try {
    for (const [relative, bytes] of files) {
      const target = path.join(temporary, "source", ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    await rename(temporary, root);
    const workspace = HarnessWorkspaceSchema.parse({
      schemaVersion: "openpond.harnessWorkspace.v1",
      id: workspaceId,
      ownerScope: { kind: "personal", id: DESKTOP_PERSONAL_HARNESS_OWNER_ID },
      name: "Captured Work Harness",
      location: "local",
      sourceRevision: source.contentHash,
      revision: 0,
      dirty: false,
      currentChannel: {
        name: "personal",
        release: { id: source.harnessRelease.id, contentHash: hash },
        revision: 1,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { capturedSourcePackageHash: source.contentHash },
    });
    const release = LocalHarnessReleaseRecordSchema.parse({
      schemaVersion: "openpond.localHarnessReleaseRecord.v1",
      workspaceId,
      sourceRevision: source.contentHash,
      agentSnapshot: source.agentSnapshot,
      harnessRelease: source.harnessRelease,
      bundlePath: root,
      createdAt: timestamp,
    });
    // Validate with the actual Work Skill loader before making this release selectable.
    const runtime = await loadLocalHarnessRuntimeFromRelease({ workspace, release });
    await input.store.createHarnessWorkspaceWithRelease({ workspace, release });
    return runtime;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
