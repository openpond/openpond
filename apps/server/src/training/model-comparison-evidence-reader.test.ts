import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelRun } from "@openpond/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { readModelComparisonAttemptEvidence } from "./model-comparison-evidence-reader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("model comparison evidence reader", () => {
  it("resolves only the receipt-authorized JSON pointer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openpond-evidence-"));
    roots.push(root);
    const directory = path.join(root, "training", "comparison-evaluations");
    const artifactPath = path.join(directory, "receipt.json");
    await mkdir(directory, { recursive: true });
    await writeFile(artifactPath, JSON.stringify({ attempts: [{ evidence: { messages: [{ role: "assistant", content: "verified" }] }, trace: { reward: 1 } }] }));
    const run = fixtureRun(artifactPath);
    const result = await readModelComparisonAttemptEvidence({
      store: { getModelRun: async () => run } as never,
      storeDir: root,
      runId: run.id,
      attemptId: "attempt-1",
      kind: "transcript",
    });
    expect(result.value).toEqual([{ role: "assistant", content: "verified" }]);
    expect(result.jsonPointer).toBe("/attempts/0/evidence/messages");
  });

  it("rejects a receipt artifact outside the comparison evidence store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openpond-evidence-"));
    roots.push(root);
    const directory = path.join(root, "training", "comparison-evaluations");
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(root, "outside.json");
    await writeFile(artifactPath, JSON.stringify({ attempts: [] }));
    await expect(readModelComparisonAttemptEvidence({
      store: { getModelRun: async () => fixtureRun(artifactPath) } as never,
      storeDir: root,
      runId: "evaluation-1",
      attemptId: "attempt-1",
      kind: "trace",
    })).rejects.toThrow("outside the authorized comparison-evidence store");
  });
});

function fixtureRun(artifactPath: string): ModelRun {
  const hash = "a".repeat(64);
  return {
    id: "evaluation-1",
    receipt: {
      schemaVersion: "openpond.modelComparisonBenchmarkReceipt.v1",
      attempts: [{
        attemptId: "attempt-1",
        transcriptHash: hash,
        traceHash: hash,
        transcriptArtifact: { artifactPath, jsonPointer: "/attempts/0/evidence/messages" },
        traceArtifact: { artifactPath, jsonPointer: "/attempts/0/trace" },
      }],
    },
  } as ModelRun;
}
