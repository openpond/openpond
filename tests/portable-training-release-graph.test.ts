import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ContentAddressedReleaseStore,
  materializeHarnessRelease,
  materializeResolvedTrainingBundle,
  createHarnessRunManifest,
  validateHarnessRunManifest,
} from "@openpond/training-sdk";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import {
  createEvidenceFixture,
  createHarnessFixture,
  createManifestFixture,
} from "./helpers/portable-training-fixtures.js";

describe("portable training release graph", () => {
  it("binds an immutable harness and evidence graph into a canonical manifest", () => {
    const { release } = createHarnessFixture();
    const evidence = createEvidenceFixture(release);
    const manifest = createManifestFixture({ harness: release, evidence: [evidence] });
    expect(
      validateHarnessRunManifest(manifest, {
        harnessRelease: release,
        evidenceSets: [evidence],
      }),
    ).toEqual([]);
  });

  it("rejects missing required leases and cross-Model evidence", () => {
    const { release } = createHarnessFixture();
    const evidence = createEvidenceFixture(release);
    const manifest = createManifestFixture({
      harness: release,
      evidence: [evidence],
    });
    const {
      contentHash: _manifestHash,
      secretLeaseRefs: _leases,
      ...withoutLeases
    } = manifest;
    const missingLease = createHarnessRunManifest({
      ...withoutLeases,
      secretLeaseRefs: [],
    });
    expect(
      validateHarnessRunManifest(missingLease, {
        harnessRelease: release,
        evidenceSets: [evidence],
      }).map((issue) => issue.code),
    ).toContain("required_secret_lease_missing");

    const driftedEvidence = {
      ...evidence,
      model: {
        ...evidence.model,
        revision: "another-model-revision",
      },
    };
    const driftedEvidenceContent = Object.fromEntries(
      Object.entries(driftedEvidence).filter(
        ([key]) => key !== "contentHash",
      ),
    );
    driftedEvidence.contentHash = contentHash(driftedEvidenceContent);
    const driftedManifest = createManifestFixture({
      harness: release,
      evidence: [driftedEvidence],
    });
    expect(
      validateHarnessRunManifest(driftedManifest, {
        harnessRelease: release,
        evidenceSets: [driftedEvidence],
      }).map((issue) => issue.code),
    ).toContain("evidence_model_mismatch");
  });

  it("detects a release changed after publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-release-store-"));
    try {
      const { release, assets } = createHarnessFixture();
      const store = new ContentAddressedReleaseStore(root);
      await store.publishHarnessRelease({
        release,
        readAsset: async (asset) => assets.get(asset.path)!,
      });
      expect(
        await store.readHarnessRelease({
          id: release.id,
          revision: release.revision,
          contentHash: release.contentHash,
        }),
      ).toEqual(release);
      await expect(
        store.resolveHarnessRelease({
          id: release.id,
          contentHash: release.contentHash,
        }),
      ).resolves.toEqual(release);
      await expect(
        store.publishHarnessRelease({
          release: { ...release, sourceRevision: "mutated" },
          readAsset: async (asset) => assets.get(asset.path)!,
        }),
      ).rejects.toThrow(/content hash|validation failed/i);
      const storedRelease = path.join(
        root,
        "releases",
        "harness",
        release.id,
        String(release.revision),
        `${release.contentHash}.json`,
      );
      await writeFile(
        storedRelease,
        JSON.stringify({ ...release, sourceRevision: "tampered" }),
      );
      await expect(
        store.readHarnessRelease({
          id: release.id,
          revision: release.revision,
          contentHash: release.contentHash,
        }),
      ).rejects.toThrow(/immutable identity/i);
      await expect(store.readObject("../unsafe")).rejects.toThrow(
        /content hash is invalid/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes isolated projections deterministically and detects corruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openpond-materializer-"));
    try {
      const { release, assets } = createHarnessFixture();
      const readAsset = async (asset: (typeof release.assets)[number]) =>
        assets.get(asset.path)!;
      const target = {
        adapterId: "runtime-local",
        projection: "student" as const,
        runtimeVersion: "1",
        expectedContracts: release.requiredContracts,
      };
      const first = await materializeHarnessRelease({
        release,
        cacheRoot: root,
        target,
        readAsset,
      });
      const second = await materializeHarnessRelease({
        release,
        cacheRoot: root,
        target,
        readAsset,
      });
      expect(first.cacheHit).toBe(false);
      expect(second.cacheHit).toBe(true);
      expect(first.directory).toBe(second.directory);
      expect(first.manifest.files.map((file) => file.path)).toEqual(["student.ts"]);
      await expect(readFile(path.join(first.directory, "grader.ts"))).rejects.toThrow();
      await writeFile(path.join(first.directory, "unlisted.txt"), "unexpected");
      await expect(
        materializeHarnessRelease({
          release,
          cacheRoot: root,
          target,
          readAsset,
        }),
      ).rejects.toThrow(/inventory changed/i);
      await rm(path.join(first.directory, "unlisted.txt"));
      await writeFile(path.join(first.directory, "student.ts"), "corrupt");
      await expect(
        materializeHarnessRelease({
          release,
          cacheRoot: root,
          target,
          readAsset,
        }),
      ).rejects.toThrow(/changed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes and re-verifies the exact resolved run bundle hash", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "openpond-resolved-bundle-"),
    );
    try {
      const bytes = Buffer.from("exact harness asset", "utf8");
      const base = {
        schemaVersion: "openpond.resolvedTrainingBundle.v1" as const,
        projection: "trainer" as const,
        harnessRelease: {
          id: "harness-1",
          contentHash: sha256("harness"),
        },
        datasetRelease: {
          id: "dataset-1",
          contentHash: sha256("dataset"),
        },
        evidenceSetRelease: null,
        files: [
          {
            path: "program.json",
            sha256: sha256(bytes),
            sizeBytes: bytes.byteLength,
          },
        ],
      };
      const manifest = {
        ...base,
        contentHash: contentHash(base),
      };
      const first = await materializeResolvedTrainingBundle({
        manifest,
        assets: new Map([["program.json", bytes]]),
        cacheRoot: root,
      });
      const replay = await materializeResolvedTrainingBundle({
        manifest,
        assets: new Map([["program.json", bytes]]),
        cacheRoot: root,
      });
      expect(first.manifest.contentHash).toBe(manifest.contentHash);
      expect(replay.cacheHit).toBe(true);
      await writeFile(
        path.join(first.directory, "unlisted.json"),
        "unexpected",
      );
      await expect(
        materializeResolvedTrainingBundle({
          manifest,
          assets: new Map([["program.json", bytes]]),
          cacheRoot: root,
        }),
      ).rejects.toThrow(/inventory changed/i);
      await rm(path.join(first.directory, "unlisted.json"));
      await writeFile(
        path.join(first.directory, "program.json"),
        "corrupt",
      );
      await expect(
        materializeResolvedTrainingBundle({
          manifest,
          assets: new Map([["program.json", bytes]]),
          cacheRoot: root,
        }),
      ).rejects.toThrow(/changed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
