import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { TaskAttemptResult } from "@openpond/contracts";
import { ModelJudgeExecutionError } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import type { SqliteStore } from "../store/store.js";
import {
  createTaskAttemptModelJudge,
  loadTaskAttemptGraderEvidence,
} from "./task-attempt-grader-evidence.js";

const execFileAsync = promisify(execFile);

describe("task attempt grader evidence", () => {
  test("conservatively prices a judge response when provider usage is absent", async () => {
    const store = {
      listTaskAttemptArtifacts: async () => [],
    } as unknown as SqliteStore;
    const judge = createTaskAttemptModelJudge({
      store,
      modelText: async () => JSON.stringify({
        score: 1,
        passed: true,
        feedback: "Meets the criterion.",
        criterionScores: [{
          criterionId: "criterion-1",
          score: 1,
          passed: true,
          feedback: "Meets the criterion.",
          evidenceRefs: [],
        }],
      }),
    });

    const result = await judge({
      grader: {
        id: "judge-1",
        version: "1",
        label: "Judge",
        kind: "model_judge",
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        rubric: "Assess criterion-1.",
        judge: { providerId: "openpond", modelId: "judge-model" },
        calibrationFixtureRefs: [],
        calibrationStatus: "passed",
        temperature: 0,
        metadata: {},
      },
      task: {
        id: "task-1",
        input: { prompt: "Do the work." },
        policyVisibleContext: {},
        evaluationCriteria: [{
          id: "criterion-1",
          description: "Complete the work.",
          scorerIds: ["judge-1"],
          weight: 1,
          hardGate: true,
        }],
      } as never,
      attempt: {
        id: "attempt-1",
        output: { text: "Done." },
        modelRef: { providerId: "openpond", modelId: "judge-model" },
        metadata: {
          hostedTokenPricing: {
            version: "test-v1",
            source: "test",
            effectiveAt: "2026-08-19T00:00:00.000Z",
            inputUsdPerMillionTokens: 1,
            cachedInputUsdPerMillionTokens: 0.5,
            outputUsdPerMillionTokens: 2,
          },
        },
      } as unknown as TaskAttemptResult,
    });

    expect(result.usage).toEqual([]);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test("preserves conservative cost when structured judge output is invalid", async () => {
    const store = {
      listTaskAttemptArtifacts: async () => [],
    } as unknown as SqliteStore;
    const judge = createTaskAttemptModelJudge({
      store,
      modelText: async () => "not valid structured output",
    });

    const failure = await judge({
      grader: {
        id: "judge-1",
        version: "1",
        label: "Judge",
        kind: "model_judge",
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        rubric: "Assess criterion-1.",
        judge: { providerId: "openpond", modelId: "judge-model" },
        calibrationFixtureRefs: [],
        calibrationStatus: "passed",
        temperature: 0,
        metadata: {},
      },
      task: {
        id: "task-1",
        input: { prompt: "Do the work." },
        policyVisibleContext: {},
        evaluationCriteria: [{
          id: "criterion-1",
          description: "Complete the work.",
          scorerIds: ["judge-1"],
          weight: 1,
          hardGate: true,
        }],
      } as never,
      attempt: {
        id: "attempt-invalid-judge",
        output: { text: "Done." },
        modelRef: { providerId: "openpond", modelId: "judge-model" },
        metadata: {
          hostedTokenPricing: {
            version: "test-v1",
            source: "test",
            effectiveAt: "2026-08-19T00:00:00.000Z",
            inputUsdPerMillionTokens: 1,
            cachedInputUsdPerMillionTokens: 0.5,
            outputUsdPerMillionTokens: 2,
          },
        },
      } as unknown as TaskAttemptResult,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelJudgeExecutionError);
    expect((failure as ModelJudgeExecutionError).costUsd).toBeGreaterThan(0);
  });

  test("accepts exact criterion scores on the second bounded repair", async () => {
    const store = {
      listTaskAttemptArtifacts: async () => [],
    } as unknown as SqliteStore;
    let calls = 0;
    const judge = createTaskAttemptModelJudge({
      store,
      modelText: async () => {
        calls += 1;
        if (calls < 3) return "invalid";
        return JSON.stringify({
          score: 1,
          passed: true,
          feedback: "Meets the criterion.",
          criterionScores: [{
            criterionId: "criterion-1",
            score: 1,
            passed: true,
            feedback: "Meets the criterion.",
            evidenceRefs: [],
          }],
        });
      },
    });

    const result = await judge({
      grader: {
        id: "judge-1",
        version: "1",
        label: "Judge",
        kind: "model_judge",
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        rubric: "Assess criterion-1.",
        judge: { providerId: "openpond", modelId: "judge-model" },
        calibrationFixtureRefs: [],
        calibrationStatus: "passed",
        temperature: 0,
        metadata: {},
      },
      task: {
        id: "task-1",
        input: { prompt: "Do the work." },
        policyVisibleContext: {},
        evaluationCriteria: [{
          id: "criterion-1",
          description: "Complete the work.",
          scorerIds: ["judge-1"],
          weight: 1,
          hardGate: true,
        }],
      } as never,
      attempt: {
        id: "attempt-repaired-judge",
        output: { text: "Done." },
        modelRef: { providerId: "openpond", modelId: "judge-model" },
        metadata: {
          hostedTokenPricing: {
            version: "test-v1",
            source: "test",
            effectiveAt: "2026-08-19T00:00:00.000Z",
            inputUsdPerMillionTokens: 1,
            cachedInputUsdPerMillionTokens: 0.5,
            outputUsdPerMillionTokens: 2,
          },
        },
      } as unknown as TaskAttemptResult,
    });

    expect(calls).toBe(3);
    expect(result.criterionScores).toHaveLength(1);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test("extracts bounded text and structure from Open XML artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openpond-grader-evidence-"));
    try {
      await mkdir(path.join(root, "word"));
      await writeFile(
        path.join(root, "word", "document.xml"),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="urn:test"><w:body>',
          '<w:p><w:r><w:t>Quarterly operating review</w:t></w:r></w:p>',
          '<w:p><w:r><w:t>Revenue increased by 12 percent.</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(""),
      );
      const artifactPath = path.join(root, "review.docx");
      await execFileAsync("zip", ["-q", "-r", artifactPath, "word"], { cwd: root });
      const store = {
        listTaskAttemptArtifacts: async () => [{
          id: "artifact-1",
          kind: "output_artifact",
          path: artifactPath,
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sha256: "a".repeat(64),
          sizeBytes: 1_000,
          metadata: { requiredOutputPath: "review.docx" },
        }],
      } as unknown as SqliteStore;
      const evidence = await loadTaskAttemptGraderEvidence({
        store,
        attempt: { id: "attempt-1" } as TaskAttemptResult,
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        extraction: "open_xml_text",
        requiredOutputPath: "review.docx",
        structure: {
          archiveEntryCount: 2,
          extractedEntryCount: 1,
        },
      });
      expect(evidence[0]?.content).toContain("Quarterly operating review");
      expect(evidence[0]?.content).toContain("Revenue increased by 12 percent.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
