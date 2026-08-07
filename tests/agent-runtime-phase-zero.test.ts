import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

type FixtureReference = {
  id: string;
  path: string;
  sha256: string;
};

type CharacterizationManifest = {
  schemaVersion: string;
  canonicalization: Record<string, unknown>;
  local: FixtureReference[];
  hosted: FixtureReference[];
  productGate: {
    pullRequest: string;
    mergeCommit: string;
    test: string;
    invariant: string;
  };
};

const manifestPath = path.resolve(
  "tests/fixtures/runtime-convergence/phase-0-characterization.json",
);

async function loadManifest(): Promise<CharacterizationManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as CharacterizationManifest;
}

describe("agent runtime Phase 0 characterization", () => {
  test("records every required Local and hosted behavior family", async () => {
    const manifest = await loadManifest();
    expect(manifest.schemaVersion).toBe("openpond.agentRuntimeCharacterization.v1");
    expect(manifest.local.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "provider-rounds-tool-batches-interruption",
        "provider-tools-compaction-concurrency-interruption",
        "approval-and-user-input-projection",
        "harness-admission-refine-advancement-failure-avoidance",
        "candidate-validation-review-rollback",
        "skill-loading-memory-tools-release-materialization",
      ]),
    );
    expect(manifest.hosted.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "provider-rounds-checkpoints-tools-waits-cancellation",
        "sandbox-and-managed-tool-adapters",
        "durable-event-ordering",
        "web-event-projection",
        "turn-service-cancellation-and-outputs",
      ]),
    );
    expect(Object.keys(manifest.canonicalization)).toEqual(
      expect.arrayContaining([
        "algorithm",
        "serialization",
        "eventFields",
        "toolResultFields",
        "checkpointFields",
        "capabilityFields",
        "effectiveSurfaceFields",
      ]),
    );
  });

  test("pins Local executable fixtures to the pre-extraction baseline", async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.local) {
      const contents = await readFile(path.resolve(fixture.path));
      const digest = createHash("sha256").update(contents).digest("hex");
      expect(digest, fixture.id).toBe(fixture.sha256);
    }
  });

  test("keeps failure avoidance as an explicit product invariant", async () => {
    const manifest = await loadManifest();
    expect(manifest.productGate.pullRequest).toBe(
      "https://github.com/openpond/openpond/pull/69",
    );
    expect(manifest.productGate.mergeCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.productGate.test).toBe(
      "apps/server/src/harness/local-harness-refinement-acceptance.test.ts",
    );
    expect(manifest.productGate.invariant).toContain("fresh task");
    expect(manifest.productGate.invariant).toContain("avoids the failed command");
  });
});
