import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ManagedTrainingRunEvidenceSchema,
  type ManagedTrainingRunEvidence,
  type TrainingExecutionRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  canonicalJson,
  parseAndVerifyTrainingEvaluationTaskPage,
  type TrainingEvaluationSource,
  type TrainingEvaluationTaskPage,
} from "openpond-sdk/training";
import { z } from "zod";
import type { SqliteStore } from "../store/store.js";
import { loadManagedTrainingEvaluationSource } from "./managed-training-evaluation-source.js";

const PageOptionsSchema = z.object({
  cursor: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number(value) <= 9_999)
    .optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function readManagedTrainingEvaluationTasksForRun(input: {
  store: SqliteStore;
  storeDir: string;
  ref: TrainingExecutionRef;
  evaluationId: string;
  options: { cursor?: string; limit?: number };
  fetchPage: Parameters<
    typeof readManagedTrainingEvaluationTasks
  >[0]["fetchPage"];
}) {
  const job = await input.store.getTrainingJob(input.ref.runId);
  if (
    !job ||
    !input.ref.manifestHash ||
    contentHash(job.metadata.portableExecutionRef) !== contentHash(input.ref)
  ) {
    throw new Error(
      "The retained evaluation has no matching local training execution.",
    );
  }
  const evidence = ManagedTrainingRunEvidenceSchema.parse(
    job.metadata.managedTrainingEvidence,
  );
  const source = await loadManagedTrainingEvaluationSource(
    input.storeDir,
    input.ref.manifestHash,
  );
  return readManagedTrainingEvaluationTasks({ ...input, evidence, source });
}

/** A report supplements an immutable receipt; reading it never regrades or trains. */
export async function readManagedTrainingEvaluationTasks(input: {
  storeDir: string;
  ref: TrainingExecutionRef;
  evaluationId: string;
  evidence: Pick<ManagedTrainingRunEvidence, "providerRunId" | "evaluations">;
  source: {
    taskset: TrainingEvaluationSource["taskset"];
    tasks: ReadonlyArray<{ id: string }>;
  };
  options?: { cursor?: string; limit?: number };
  fetchPage: (
    evaluation: { id: string; contentHash: string },
    options: { cursor?: string; limit: number },
  ) => Promise<TrainingEvaluationTaskPage>;
}): Promise<TrainingEvaluationTaskPage> {
  const options = PageOptionsSchema.parse(input.options ?? {});
  if (!input.ref.tenantId || input.evidence.providerRunId !== input.ref.runId) {
    throw new Error(
      "The retained evaluation belongs to a different training run.",
    );
  }
  const evaluation = input.evidence.evaluations.find(
    (value) => value.reference?.id === input.evaluationId,
  );
  if (!evaluation?.reference)
    throw new Error(
      "The training run has no retained reference for this evaluation.",
    );
  const reference = evaluation.reference;
  const expected = {
    jobId: input.ref.runId,
    teamId: input.ref.tenantId,
    evaluation: reference,
    offset: Number(options.cursor ?? 0),
  };
  const directory = path.join(input.storeDir, "training", "evaluation-reports");
  const filename = path.join(
    directory,
    `${contentHash({ ...expected, manifestHash: input.ref.manifestHash, limit: options.limit })}.json`,
  );
  let cached: string | null = null;
  try {
    cached = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const page = await parseAndVerifyTrainingEvaluationTaskPage(
    cached === null
      ? await input.fetchPage(reference, options)
      : JSON.parse(cached),
    expected,
  );
  if (
    page.kind !== evaluation.kind ||
    page.policyVersion !== evaluation.policyVersion ||
    contentHash(page.taskset) !== contentHash(input.source.taskset) ||
    page.total !== input.source.tasks.length ||
    contentHash(page.tasks.map((task) => task.taskId)) !==
      contentHash(
        input.source.tasks
          .slice(page.offset, page.offset + page.tasks.length)
          .map((task) => task.id),
      )
  ) {
    throw new Error(
      "The evaluation report differs from the run's pinned held-out tasks or policy.",
    );
  }
  if (cached === null) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, canonicalJson(page), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return page;
}
