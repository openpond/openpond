type PayloadRow = { id: string; payload: string };

export async function retireLegacyHarnessBenchmarkRuns(input: {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<number> {
  const rows = await input.all<PayloadRow>(
    "SELECT id, payload FROM model_runs",
    [],
  );
  let retired = 0;
  for (const row of rows) {
    const parsed = JSON.parse(row.payload) as unknown;
    const next = retireLegacyHarnessBenchmarkRun(parsed);
    if (next === parsed) continue;
    const migrated = next as Record<string, unknown>;
    await input.run(
      "UPDATE model_runs SET status = ?, payload = ?, updated_at = ? WHERE id = ?",
      [migrated.status, JSON.stringify(migrated), migrated.updatedAt, row.id],
    );
    retired += 1;
  }
  return retired;
}

export function retireLegacyHarnessBenchmarkRun(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const run = value as Record<string, unknown>;
  const evaluation = record(run.evaluation);
  if (
    run.kind !== "evaluation"
    || evaluation.benchmarkId !== "harness-refiner"
    || (
      !("mode" in evaluation)
      && Array.isArray(evaluation.attemptPlan)
      && concreteRevision(evaluation.upstreamModel)
    )
  ) return value;

  const receipt = record(run.receipt);
  const attempts = Array.isArray(receipt.attempts)
    ? receipt.attempts.filter((attempt): attempt is Record<string, unknown> =>
        Boolean(attempt) && typeof attempt === "object" && !Array.isArray(attempt)
      )
    : [];
  const baselineIds = taskIds(attempts, "baseline", "legacy-held-out");
  const adaptationIds = taskIds(attempts, "adaptation", "legacy-adaptation");
  const candidateIds = taskIds(attempts, "candidate", "legacy-held-out");
  const updatedAt = typeof run.updatedAt === "string"
    ? run.updatedAt
    : new Date(0).toISOString();
  const upstream = record(evaluation.upstreamModel);
  const { mode: _retiredMode, ...retainedEvaluation } = evaluation;
  return {
    ...run,
    status: "failed",
    evaluation: {
      ...retainedEvaluation,
      upstreamModel: {
        providerId: string(upstream.providerId) ?? "unresolved",
        modelId: string(upstream.modelId) ?? "unresolved",
        revision: string(upstream.revision) ?? "legacy-unresolved",
      },
      attemptPlan: [
        plan("baseline", "frozen_eval", baselineIds),
        plan("adaptation", "validation", adaptationIds),
        plan("candidate_adaptation", "validation", adaptationIds),
        plan("candidate", "frozen_eval", candidateIds),
      ],
    },
    evaluationProgress: {
      stage: "comparison",
      completedAttempts: 0,
      totalAttempts:
        baselineIds.length + adaptationIds.length * 2 + candidateIds.length,
    },
    receipt: null,
    failure:
      "Historical Harness Refiner run retired during the forty-attempt protocol migration; its managed result and Profile Git artifacts remain the diagnostic record.",
    completedAt: typeof run.completedAt === "string" ? run.completedAt : updatedAt,
    updatedAt,
  };
}

function plan(stage: string, split: string, taskIds: string[]) {
  return { stage, split, taskIds, attemptCount: taskIds.length };
}

function taskIds(
  attempts: Record<string, unknown>[],
  phase: string,
  fallback: string,
): string[] {
  const ids = [...new Set(attempts
    .filter((attempt) => attempt.phase === phase)
    .map((attempt) => string(attempt.taskId))
    .filter((id): id is string => Boolean(id)))];
  return ids.length ? ids : [fallback];
}

function concreteRevision(value: unknown): boolean {
  return Boolean(string(record(value).revision));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
