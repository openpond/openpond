import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveStoredPath } from "@openpond/persistence";

import type { ModelComparisonBenchmarkReceipt, ModelRun } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";

export type ModelComparisonAttemptEvidence = {
  runId: string;
  attemptId: string;
  kind: "transcript" | "trace";
  artifactPath: string;
  jsonPointer: string;
  contentHash: string | null;
  value: unknown;
};

export async function readModelComparisonAttemptEvidence(input: {
  store: SqliteStore;
  storeDir: string;
  runId: string;
  attemptId: string;
  kind: "transcript" | "trace";
}): Promise<ModelComparisonAttemptEvidence> {
  const run = await input.store.getModelRun(input.runId);
  if (!run) throw new Error("The requested comparison Evaluation was not found.");
  const receipt = comparisonReceipt(run);
  if (!receipt) throw new Error("The requested comparison Evaluation has no terminal receipt.");
  const attempt = receipt.attempts.find((candidate) => candidate.attemptId === input.attemptId);
  if (!attempt) throw new Error("The requested attempt does not belong to this Evaluation receipt.");
  const artifact = input.kind === "transcript" ? attempt.transcriptArtifact : attempt.traceArtifact;
  if (!artifact) throw new Error(`This attempt has no ${input.kind} artifact.`);

  const evidenceRoot = await realpath(path.join(input.storeDir, "training", "comparison-evaluations"));
  const artifactPath = await realpath(resolveStoredPath(input.storeDir, artifact.artifactPath));
  if (artifactPath !== evidenceRoot && !artifactPath.startsWith(`${evidenceRoot}${path.sep}`)) {
    throw new Error("The receipt points outside the authorized comparison-evidence store.");
  }
  if (path.extname(artifactPath).toLowerCase() !== ".json") {
    throw new Error("Comparison attempt evidence must be a JSON artifact.");
  }
  const document = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
  return {
    runId: run.id,
    attemptId: input.attemptId,
    kind: input.kind,
    artifactPath,
    jsonPointer: artifact.jsonPointer,
    contentHash: input.kind === "transcript" ? attempt.transcriptHash : attempt.traceHash,
    value: resolveJsonPointer(document, artifact.jsonPointer),
  };
}

function comparisonReceipt(run: ModelRun | null): ModelComparisonBenchmarkReceipt | null {
  return run?.receipt?.schemaVersion === "openpond.modelComparisonBenchmarkReceipt.v1"
    ? run.receipt
    : null;
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) throw new Error("The receipt contains an invalid JSON pointer.");
  let current = document;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part) || Number(part) >= current.length) throw new Error("The receipt JSON pointer does not resolve.");
      current = current[Number(part)];
      continue;
    }
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new Error("The receipt JSON pointer does not resolve.");
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
