import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HARVEY_LAB_LEGAL_SCENARIOS,
  HARVEY_LAB_LEGAL_WEEK0_TASKSET_ID,
  HARVEY_LAB_REVISION,
  materializeHarveyLabLegalTaskset,
  validateTaskset,
  type HarveyLabClient,
} from "../packages/taskset-sdk/src";

describe("Harvey LAB legal Taskset materializer", () => {
  it("pins source bytes and keeps task rubrics out of policy-visible context", async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), "openpond-harvey-lab-"));
    const fixtures = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();
    for (const [index, scenario] of HARVEY_LAB_LEGAL_SCENARIOS.entries()) {
      fixtures.set(
        `${scenario.path}/task.json`,
        encoder.encode(JSON.stringify({
          title: `Contract review ${index + 1}`,
          instructions: index === 1
            ? "Produce two deliverables: (1) `special-redline.docx` — the marked agreement; and (2) `special-memo.docx` — the issues memo. Use `source-2.docx` as an input."
            : [
                "Review the supplied contract and playbook.",
                "",
                "### Output:",
                "contract-redline.docx",
                "issues-risk-memo.docx",
              ].join("\n"),
          criteria: [{
            id: "C-001",
            title: "Required issue identified",
            match_criteria: "PASS when the memo identifies the issue; otherwise FAIL.",
          }],
        })),
      );
      fixtures.set(
        `${scenario.path}/documents/source-${index + 1}.docx`,
        encoder.encode(`fake-docx-${index + 1}`),
      );
    }
    const client: HarveyLabClient = {
      async listFiles(directory) {
        return [...fixtures.entries()]
          .filter(([filePath]) => filePath.startsWith(`${directory}/`))
          .map(([filePath, bytes]) => ({ path: filePath, size: bytes.byteLength }));
      },
      async readBytes(filePath) {
        const bytes = fixtures.get(filePath);
        if (!bytes) throw new Error(`Missing fixture ${filePath}`);
        return bytes;
      },
    };

    const result = await materializeHarveyLabLegalTaskset({
      storeDir,
      client,
      now: "2026-08-30T12:00:00.000Z",
    });

    expect(result.sourceRevision).toBe(HARVEY_LAB_REVISION);
    expect(result.taskset.tasks).toHaveLength(11);
    expect(result.taskset.tasks.filter((task) => task.split === "train")).toHaveLength(7);
    expect(result.taskset.tasks.filter((task) => task.split === "validation")).toHaveLength(2);
    expect(result.taskset.tasks.filter((task) => task.split === "frozen_eval")).toHaveLength(2);
    expect(result.assetCount).toBe(11);
    expect(validateTaskset(result.taskset).valid).toBe(true);

    for (const task of result.taskset.tasks) {
      expect(task.expectedOutput).toMatchObject({ criterionCount: 1 });
      expect(task.policyVisibleContext).not.toHaveProperty("criteria");
      expect(JSON.stringify(task.policyVisibleContext)).not.toContain("PASS when");
      expect(task.requiredOutputs?.map((output) => output.path)).toEqual(
        task.policyVisibleContext.title === "Contract review 2"
          ? ["special-redline.docx", "special-memo.docx"]
          : ["contract-redline.docx", "issues-risk-memo.docx"],
      );
      expect(task.assets).toHaveLength(1);
      const asset = task.assets![0]!;
      const materialized = await readFile(path.join(result.tasksetRoot, asset.artifactRef));
      expect(materialized.byteLength).toBe(asset.sizeBytes);
    }

    const persisted = JSON.parse(
      await readFile(path.join(result.tasksetRoot, "taskset.json"), "utf8"),
    );
    expect(persisted.contentHash).toBe(result.taskset.contentHash);
    expect(persisted.authoringProvenance.sourceCommit).toBe(HARVEY_LAB_REVISION);
    expect(persisted.graders[0]).toMatchObject({
      kind: "model_judge",
      rewardEligible: true,
      calibrationStatus: "pending",
      metadata: { userSelectedReward: true, calibrationIsAdvisory: true },
    });

    const week0 = await materializeHarveyLabLegalTaskset({
      storeDir,
      client,
      releaseStage: "week0",
      now: "2026-08-30T12:00:00.000Z",
    });
    expect(week0.taskset.id).toBe(HARVEY_LAB_LEGAL_WEEK0_TASKSET_ID);
    expect(week0.taskset.tasks).toHaveLength(6);
    expect(week0.taskset.tasks.filter((task) => task.split === "train")).toHaveLength(4);
    expect(week0.taskset.tasks.filter((task) => task.split === "validation")).toHaveLength(1);
    expect(week0.taskset.tasks.filter((task) => task.split === "frozen_eval")).toHaveLength(1);
    expect(week0.taskset.tasks.every((task) => task.metadata.release === "week0-msa")).toBe(true);
  });
});
