import {
  TaskAttemptResultSchema,
  type DatasetSplit,
} from "@openpond/contracts";

type AuditFixture = {
  id: string;
  taskId: string;
  label: string;
  output: Record<string, unknown>;
  infrastructureError: string | null;
  metadata?: Record<string, unknown>;
};

export function fixtureAttempt(
  tasksetId: string,
  fixture: AuditFixture,
  index: number,
) {
  const timestamp = new Date().toISOString();
  return TaskAttemptResultSchema.parse({
    schemaVersion: "openpond.taskAttempt.v1",
    id: `fixture_attempt_${fixture.id}_${index}`,
    tasksetId,
    taskId: fixture.taskId,
    split: artifactSplit(fixture) ?? "frozen_eval",
    attempt: index,
    seed: 0,
    modelRef: null,
    startedAt: timestamp,
    completedAt: timestamp,
    output: fixture.output,
    runtimeEventRefs: [],
    artifactRefs: [],
    privilegedOutcomeRef: null,
    infrastructureError: fixture.infrastructureError,
    costUsd: 0,
    latencyMs: 0,
    userInterventions: 0,
    metadata: { fixtureLabel: fixture.label },
  });
}

export function artifactSplit(fixture: unknown): DatasetSplit | null {
  const value =
    fixture
    && typeof fixture === "object"
    && !Array.isArray(fixture)
    && "metadata" in fixture
    && fixture.metadata
    && typeof fixture.metadata === "object"
    && !Array.isArray(fixture.metadata)
      ? (fixture.metadata as Record<string, unknown>).artifactSplit
      : null;
  return value === "train"
      || value === "validation"
      || value === "test"
      || value === "frozen_eval"
    ? value
    : null;
}
