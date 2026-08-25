import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Taskset } from "@openpond/contracts";
import {
  materializeSyntheticCollectionRun,
  SyntheticCollectionRunRequestSchema,
} from "./synthetic-collection-run.js";

const HASH = "a".repeat(64);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N4QAAAAASUVORK5CYII=";

function taskset(): Taskset {
  return {
    id: "taskset_fixture",
    revision: 1,
    contentHash: HASH,
    tasks: [
      { id: "scenario-train", split: "train", privilegedContextRef: null },
      { id: "scenario-validation", split: "validation", privilegedContextRef: null },
    ],
  } as unknown as Taskset;
}

function request() {
  return {
    schemaVersion: "openpond.syntheticCollectionRun.v1" as const,
    id: "collection-c0",
    tasksetId: "taskset_fixture",
    fixtureRelease: { id: "fixture-c0", contentHash: HASH },
    labelerRelease: { id: "labeler-c0", contentHash: HASH },
    groups: ["scenario-train", "scenario-validation"].map((scenarioId, groupIndex) => ({
      scenarioId,
      partition: groupIndex === 0 ? "reward_train" as const : "reward_validation" as const,
      candidates: ["love", "like", "reject", "reject"].map((label, candidateIndex) => ({
        id: `candidate-${groupIndex}-${candidateIndex}`,
        output: JSON.stringify({ traits: { background: `variant-${groupIndex}-${candidateIndex}` } }),
        imageDataUrl: PNG,
        label: label as "love" | "like" | "reject",
      })),
    })),
  };
}

describe("synthetic collection run", () => {
  it("materializes bounded generic attempts and PNG artifacts without human authority", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-c0-"));
    const attempts: unknown[] = [];
    const artifacts: Array<{ path: string }> = [];
    const store = {
      saveTaskAttempt: async (attempt: unknown) => { attempts.push(attempt); return attempt; },
      saveTaskAttemptArtifact: async (artifact: { path: string }) => { artifacts.push(artifact); return artifact; },
    };
    try {
      const result = await materializeSyntheticCollectionRun({
        store: store as never,
        storeDir: directory,
        taskset: taskset(),
        request: SyntheticCollectionRunRequestSchema.parse(request()),
        now: () => "2026-08-25T12:00:00.000Z",
      });
      expect(result.attempts).toHaveLength(8);
      expect(attempts).toHaveLength(8);
      expect(artifacts).toHaveLength(8);
      expect(result.attempts.every((item) => item.attempt.metadata.syntheticOnly === true)).toBe(true);
      expect((await readFile(artifacts[0]!.path)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate candidate output before any collection is written", () => {
    const invalid = request();
    invalid.groups[0]!.candidates[1]!.output = invalid.groups[0]!.candidates[0]!.output;
    expect(() => SyntheticCollectionRunRequestSchema.parse(invalid)).toThrow("distinct structured outputs");
  });
});
