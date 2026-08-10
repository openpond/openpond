import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { TaskAttemptResult } from "@openpond/contracts";
import type { ModelJudgeRunner } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import { executableSearchPath } from "../runtime/executable-search-path-bun-compat.js";
import { parseModelJudgeResult } from "../server-entry-helpers.js";
import type { createTrainingModelRuntime } from "./training-model-runtime.js";

const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 40_000;
const execFileAsync = promisify(execFile);

type TrainingModelText = ReturnType<
  typeof createTrainingModelRuntime
>["trainingModelText"];

export function createTaskAttemptModelJudge(input: {
  store: SqliteStore;
  modelText: TrainingModelText;
}): ModelJudgeRunner {
  return async ({ grader, task, attempt }) => {
    const usages: unknown[] = [];
    let costUsd = 0;
    const artifactEvidence = await loadTaskAttemptGraderEvidence({
      store: input.store,
      attempt,
    });
    const raw = await input.modelText({
      model: grader.judge,
      signal: new AbortController().signal,
      requestId: `task-judge:${attempt.id}:${grader.id}`,
      onUsage: (usage, cost) => {
        usages.push(usage);
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
          costUsd += cost;
        }
      },
      messages: [
        {
          role: "system",
          content: `Apply this rubric and return JSON only with score (0..1), passed, and feedback.\n\n${grader.rubric}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            input: task.input,
            expectedOutput: task.expectedOutput,
            output: attempt.output,
            artifactEvidence,
          }),
        },
      ],
    });
    const parsed = parseModelJudgeResult(raw);
    if (!parsed) throw new Error("Model judge returned invalid structured output.");
    return {
      ...parsed,
      usage: usages,
      ...(costUsd > 0 ? { costUsd } : {}),
    };
  };
}

export async function loadTaskAttemptGraderEvidence(input: {
  store: SqliteStore;
  attempt: TaskAttemptResult;
}): Promise<Array<Record<string, unknown>>> {
  const artifacts = (await input.store.listTaskAttemptArtifacts({
    attemptId: input.attempt.id,
  }))
    .filter((artifact) => artifact.kind === "output_artifact")
    .slice(0, MAX_ARTIFACTS);
  return Promise.all(artifacts.map(async (artifact) => {
    const base = {
      artifactId: artifact.id,
      mediaType: artifact.mediaType ?? null,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      requiredOutputPath:
        typeof artifact.metadata.requiredOutputPath === "string"
          ? artifact.metadata.requiredOutputPath
          : null,
    };
    if (artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
      return { ...base, extraction: "omitted", reason: "artifact exceeds inspection bound" };
    }
    try {
      if (artifact.mediaType === "application/pdf") {
        const { stdout } = await execFileAsync("pdftotext", [artifact.path, "-"], {
          env: { ...process.env, PATH: executableSearchPath() },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 15_000,
        });
        return {
          ...base,
          extraction: "pdf_text",
          content: boundedText(stdout),
        };
      }
      if (isTextArtifact(artifact.mediaType)) {
        return {
          ...base,
          extraction: "text",
          content: boundedText(await readFile(artifact.path, "utf8")),
        };
      }
      return { ...base, extraction: "metadata_only" };
    } catch (error) {
      return {
        ...base,
        extraction: "unavailable",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      };
    }
  }));
}

function isTextArtifact(mediaType: string | null | undefined): boolean {
  return Boolean(
    mediaType?.startsWith("text/")
      || mediaType === "application/json"
      || mediaType === "application/xml",
  );
}

function boundedText(value: string): string {
  return value.length <= MAX_EXTRACTED_CHARS
    ? value
    : `${value.slice(0, MAX_EXTRACTED_CHARS)}\n[truncated]`;
}
