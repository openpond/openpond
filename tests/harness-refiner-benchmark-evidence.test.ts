import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { benchmarkToolFailureEvidence } from "../apps/server/src/training/harness-refiner-benchmark-service-support.js";

describe("Harness Refiner cohort evidence", () => {
  test("preserves hashed tool failure details and later recovery across the cohort", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-refiner-evidence-"));
    const tracePath = path.join(directory, "trace.json");
    const bytes = Buffer.from(JSON.stringify({
      schemaVersion: "openpond.tasksetWorkTrace.v1",
      steps: [
        {
          kind: "tool",
          turn: 1,
          name: "web_fetch",
          ok: false,
          output: "Fetch rejected a malformed URL.",
        },
        {
          kind: "tool",
          turn: 2,
          name: "web_fetch",
          ok: true,
          output: "Primary source fetched.",
        },
      ],
    }));
    try {
      await writeFile(tracePath, bytes);
      const evidence = await benchmarkToolFailureEvidence({
        attemptId: "attempt-1",
        artifacts: [{
          kind: "runtime_trace",
          path: tracePath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }],
        expectedCount: 1,
      });

      expect(evidence).toEqual({
        failures: [{
          toolName: "web_fetch",
          turn: 1,
          detail: "Fetch rejected a malformed URL.",
          recoveredLater: true,
        }],
        omittedCount: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
