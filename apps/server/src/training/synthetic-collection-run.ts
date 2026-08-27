import { z } from "zod";

import {
  TaskAttemptResultSchema,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import { persistBinaryTaskAttemptArtifact } from "./task-attempt-artifact-service.js";

const ImageDataUrlSchema = z.string()
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  .max(16 * 1024 * 1024);

export const SyntheticCollectionRunRequestSchema = z.object({
  schemaVersion: z.literal("openpond.syntheticCollectionRun.v1"),
  id: z.string().trim().min(1).max(191),
  tasksetId: z.string().trim().min(1).max(240),
  fixtureRelease: z.object({ id: z.string().trim().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  labelerRelease: z.object({ id: z.string().trim().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  groups: z.array(z.object({
    scenarioId: z.string().trim().min(1).max(240),
    partition: z.enum(["reward_train", "reward_validation"]),
    candidates: z.array(z.object({
      id: z.string().trim().min(1).max(240),
      output: z.string().trim().min(1).max(32_000),
      imageDataUrl: ImageDataUrlSchema.optional(),
      label: z.enum(["love", "like", "reject"]),
    }).strict()).length(4),
  }).strict()).min(2).max(16),
}).strict().superRefine((run, context) => {
  const candidateIds = new Set<string>();
  const outputs = new Set<string>();
  for (const [groupIndex, group] of run.groups.entries()) {
    if (new Set(group.candidates.map((candidate) => candidate.id)).size !== 4) {
      context.addIssue({ code: "custom", path: ["groups", groupIndex, "candidates"], message: "Collection candidates must have distinct IDs." });
    }
    if (new Set(group.candidates.map((candidate) => candidate.output)).size !== 4) {
      context.addIssue({ code: "custom", path: ["groups", groupIndex, "candidates"], message: "Collection candidates must have distinct structured outputs." });
    }
    if (new Set(group.candidates.map((candidate) => candidate.label)).size < 2) {
      context.addIssue({ code: "custom", path: ["groups", groupIndex, "candidates"], message: "Each collection group needs ordered fixture signal." });
    }
    for (const candidate of group.candidates) {
      if (candidateIds.has(candidate.id) || outputs.has(candidate.output)) {
        context.addIssue({ code: "custom", path: ["groups", groupIndex], message: "Collection candidates must be unique across the Run." });
      }
      candidateIds.add(candidate.id);
      outputs.add(candidate.output);
    }
  }
});

export type SyntheticCollectionRunRequest = z.infer<typeof SyntheticCollectionRunRequestSchema>;

/**
 * Fixture-only preference-data materialization. It creates normal Task Attempts from
 * compact structured output. An optional preview image may be retained for a
 * visual review protocol, but learned-reward training never depends on it.
 * Labels are fixture metadata only; the preference service later turns them
 * into authoritative synthetic receipts.
 */
export async function materializeSyntheticCollectionRun(input: {
  store: SqliteStore;
  storeDir: string;
  taskset: Taskset;
  request: SyntheticCollectionRunRequest;
  now?: () => string;
}) {
  const request = SyntheticCollectionRunRequestSchema.parse(input.request);
  if (request.tasksetId !== input.taskset.id) throw new Error("Collection Run Taskset does not match the published Taskset.");
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const attempts = [];
  for (const [groupIndex, group] of request.groups.entries()) {
    const task = input.taskset.tasks.find((candidate) => candidate.id === group.scenarioId);
    if (!task) throw new Error(`Collection scenario ${group.scenarioId} is absent from the Taskset.`);
    if ((group.partition === "reward_train" && task.split !== "train") || (group.partition === "reward_validation" && task.split !== "validation")) {
      throw new Error(`Collection scenario ${task.id} does not match its declared partition.`);
    }
    for (const [candidateIndex, candidate] of group.candidates.entries()) {
      const attemptId = `collection_attempt_${contentHash([request.id, groupIndex, candidate.id]).slice(0, 24)}`;
      const base = TaskAttemptResultSchema.parse({
        schemaVersion: "openpond.taskAttempt.v1",
        id: attemptId,
        tasksetId: input.taskset.id,
        taskId: task.id,
        split: task.split,
        attempt: candidateIndex,
        seed: groupIndex * 4 + candidateIndex,
        modelRef: null,
        startedAt: createdAt,
        completedAt: createdAt,
        output: { text: candidate.output },
        runtimeEventRefs: [],
        artifactRefs: [],
        privilegedOutcomeRef: task.privilegedContextRef,
        infrastructureError: null,
        costUsd: 0,
        latencyMs: 0,
        userInterventions: 0,
        metadata: {
          execution: "synthetic_collection_fixture",
          collectionRunId: request.id,
          collectionGroupIndex: groupIndex,
          fixtureRelease: request.fixtureRelease,
          labelerRelease: request.labelerRelease,
          fixtureLabel: candidate.label,
          tasksetHash: input.taskset.contentHash,
          syntheticOnly: true,
        },
      });
      const artifact = candidate.imageDataUrl
        ? await persistBinaryTaskAttemptArtifact({
            store: input.store,
            storeDir: input.storeDir,
            tasksetId: input.taskset.id,
            taskId: task.id,
            attemptId,
            requestId: `collection:${request.id}`,
            kind: "output_artifact",
            bytes: Buffer.from(candidate.imageDataUrl.slice("data:image/png;base64,".length), "base64"),
            mediaType: "image/png",
            fileLabel: "fixture-render",
            extension: "png",
            timestamp: now,
            metadata: { collectionRunId: request.id, syntheticOnly: true },
          })
        : null;
      const attempt = TaskAttemptResultSchema.parse({ ...base, artifactRefs: artifact ? [artifact.id] : [] });
      await input.store.saveTaskAttempt(attempt);
      attempts.push({ attempt, artifact, groupIndex, partition: group.partition, label: candidate.label });
    }
  }
  return {
    schemaVersion: "openpond.syntheticCollectionRunReceipt.v1" as const,
    id: request.id,
    taskset: { id: input.taskset.id, revision: input.taskset.revision, contentHash: input.taskset.contentHash },
    fixtureRelease: request.fixtureRelease,
    labelerRelease: request.labelerRelease,
    attempts,
    createdAt,
    contentHash: contentHash({ request, taskset: input.taskset.contentHash, createdAt }),
  };
}
