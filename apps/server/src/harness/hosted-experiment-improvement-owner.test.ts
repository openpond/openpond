import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { contentHash } from "@openpond/harness";
import { createExperimentManifest, createExperimentResult } from "@openpond/evals/experiments";
import { expect, test, vi } from "vitest";

import { SqliteStore } from "../store/store.js";
import { profileOriginFilesHash } from "../evaluations/local-experiment-profile-origin-materialization.js";
import { runHostedExperimentImprovementOwner } from "./hosted-experiment-improvement-owner.js";
import { loadSelectedLocalHarnessRuntime } from "./local-harness-skill-runtime.js";

// A hosted actor's immutable catalog must be readable without conferring the
// Desktop personal owner's authority or accepting changed private assets.
test("hosted describe reads its actor-owned compiled release while Desktop selection and changed assets remain denied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hosted-improve-owner-"));
  const repoPath = path.join(root, "repo"), storeDir = path.join(root, "state");
  const profilePath = path.join(repoPath, "profiles", "qa");
  const actor = { actorId: "hosted-owner", teamId: "owned-team" };
  const sourceRevision = contentHash("controlled accepted Profile revision");
  const catalog = { schemaVersion: "openpond.profileEvaluations.v1", definitions: [], suites: [] };
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network dispatch"));
  try {
    await mkdir(path.join(profilePath, "settings"), { recursive: true });
    await mkdir(path.join(profilePath, "instructions"));
    await mkdir(path.join(profilePath, "evals"));
    await writeFile(path.join(repoPath, "openpond-profile.json"), JSON.stringify({
      schema: "openpond.profileRepo.v1", defaultProfile: "qa",
      profiles: { qa: { path: "profiles/qa", defaultAgent: "", enabledAgents: [] } },
    }));
    await writeFile(path.join(profilePath, "settings", "profile.yaml"), "schema: openpond.profile.v1\nprofile: qa\nagents: []\n");
    await writeFile(path.join(profilePath, "instructions", "system.md"), "Use the supplied evidence.\n");
    await writeFile(path.join(profilePath, "evals", "catalog.json"), JSON.stringify(catalog));
    const manifest = createExperimentManifest({
      schemaVersion: "openpond.experimentManifest.v1", id: "owned-evidence", name: "Owned evidence",
      teamId: actor.teamId, operationId: "evidence-operation", maximumCostUsd: null,
      dataset: { id: "controlled-dataset", revision: 1, contentHash: contentHash("dataset") },
      target: { kind: "fixture", configurationHash: contentHash("fixture") }, evaluators: [],
      population: [{ caseId: "case", seed: "seed", fixtureId: null }], createdAt: "2026-10-01T00:00:00.000Z",
    });
    const evidence = { manifest, result: createExperimentResult({
      schemaVersion: "openpond.experimentResult.v1", manifest: { id: manifest.id, contentHash: manifest.contentHash },
      status: "completed", cases: [{ identity: manifest.population[0]!, status: "completed", output: "retained answer",
        error: null, feedback: [], usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, latencyMs: null },
        traceRef: null, startedAt: null, completedAt: null }], completedAt: "2026-10-01T00:00:01.000Z",
    }, manifest) };
    const input = { actor, storeDir, source: { repoPath, repositoryId: "owned-repository", profileId: "qa",
      sourceRevision, filesHash: await profileOriginFilesHash(repoPath) }, evidence, operation: "describe" };
    const description = await runHostedExperimentImprovementOwner(input) as {
      workspaceId: string; catalogHash: string; baseRelease: { id: string; contentHash: string };
    };
    expect(description.catalogHash).toBe(contentHash(catalog));
    const store = new SqliteStore(storeDir);
    let bundlePath: string;
    try {
      const workspace = await store.getHarnessWorkspace(description.workspaceId);
      expect(workspace?.ownerScope).toEqual({ kind: "personal", id: actor.actorId });
      const release = await store.getHarnessReleaseRecord(description.baseRelease.contentHash);
      expect(release?.workspaceId).toBe(description.workspaceId);
      expect(release?.harnessRelease.files.find(asset => asset.path === "evals/catalog.json")?.visibility).toBe("verifier");
      await expect(loadSelectedLocalHarnessRuntime(store, description.baseRelease)).rejects.toThrow("not available to this local owner");
      bundlePath = release!.bundlePath;
    } finally {
      await store.close();
    }
    await writeFile(path.join(bundlePath, "source", "evals", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    await expect(runHostedExperimentImprovementOwner(input)).rejects.toThrow("compiler readback changed");
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
