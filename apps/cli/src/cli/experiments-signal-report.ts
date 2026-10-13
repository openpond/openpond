import { contentHash } from "@openpond/harness";
import { LocalExperimentRecordSchema, LocalExperimentResultSchema } from "@openpond/contracts";
import { aggregateGraderScores } from "@openpond/evals/graders";
import { verifySignalPlan } from "./experiments-signal-plan";

export function scoreDistribution(values: number[]) {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, standardDeviation: null, spread: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, min: Math.min(...values), max: Math.max(...values), mean,
    standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    spread: Math.max(...values) - Math.min(...values) };
}

export function createSignalReport(rawPlan: unknown, rawResult: unknown) {
  const plan = verifySignalPlan(rawPlan), result = LocalExperimentResultSchema.parse(rawResult);
  const execution = LocalExperimentRecordSchema.parse(result.execution);
  if (contentHash({ execution: result.execution, cases: result.cases }) !== result.contentHash)
    throw new Error("Signal result content changed.");
  if (execution.packageHash !== plan.packageHash || contentHash(execution.configuration.request) !== contentHash(plan.preparation.request)
    || contentHash(execution.graders) !== contentHash(plan.preparation.graders)
    || execution.maximumCostUsd !== plan.preparation.maximumCostUsd)
    throw new Error("Signal result differs from the frozen request, package, graders or budget.");
  if (Date.parse(execution.createdAt) < Date.parse(plan.createdAt)) throw new Error("Signal plan must precede the execution.");
  const policy = plan.preparation.request.policy;
  if (policy.kind !== "hosted_harness" || execution.model.providerId !== "openpond" || execution.model.modelId !== policy.modelId
    || execution.model.maxOutputTokens !== (policy.maxOutputTokens ?? 4096)
    || execution.model.temperature !== (policy.temperature ?? 0) || execution.model.topP !== (policy.topP ?? 1))
    throw new Error("Signal execution model or sampling differs from the frozen policy.");
  for (const status of ["pending", "running", "completed", "failed", "cancelled", "unknown"] as const)
    if (execution.counts[status] !== result.cases.filter(item => item.status === status).length)
      throw new Error("Signal execution counts differ from its cases.");
  const expected = new Map(plan.preparation.request.population.map(member => [member.receiptId, member]));
  if (result.cases.length !== expected.size || new Set(result.cases.map(item => item.receiptId)).size !== expected.size)
    throw new Error("Signal result omits or duplicates planned attempts.");
  const taskMap = new Map(plan.tasks.map(task => [task.id, task]));
  const selectionHash = contentHash(plan.preparation.graders);
  for (const item of result.cases) {
    const member = expected.get(item.receiptId), task = taskMap.get(item.taskId);
    if (!member || !task || member.taskId !== item.taskId || member.seed !== item.seed
      || contentHash(item.input) !== task.inputHash || contentHash(item.policyVisibleContext) !== task.contextHash)
      throw new Error("Signal case differs from its frozen prompt, context or seed.");
    if (item.status === "completed" && (!item.profileNative || item.output === null
      || item.profileNative.modelConfigurationHash !== execution.model.configurationHash
      || contentHash(item.profileNative.source) !== contentHash(policy.source)
      || item.profileNative.outputHash !== contentHash(item.output)))
      throw new Error("Signal case lacks matching native source, model or output evidence.");
    if (!item.grade) continue;
    if (item.grade.selectionHash !== selectionHash) throw new Error("Signal grade uses different selected graders.");
    if (item.grade.grades.some(grade => grade.taskHash !== task.taskHash)
      || new Set(item.grade.grades.map(grade => grade.evidenceHash)).size !== 1)
      throw new Error("Signal criterion belongs to another prompt or inconsistent attempt evidence.");
    const components = item.grade.grades.flatMap(grade => grade.components);
    const summary = aggregateGraderScores({ graders: plan.graders, components });
    for (const key of ["score", "passed", "rewardEligible", "gradingStatus", "failureClass"] as const)
      if (item.grade[key] !== summary[key]) throw new Error("Signal score differs from retained components and frozen weights.");
    // Individual criterion summaries must also match their own exact specification.
    for (const grade of item.grade.grades) {
      const spec = plan.graders.find(spec => spec.id === grade.components[0]?.graderId)!;
      if (grade.graderSetHash !== contentHash([spec])) throw new Error("Signal criterion specification changed.");
      const checked = aggregateGraderScores({ graders: [spec], components: grade.components });
      for (const key of ["score", "passed", "rewardEligible", "gradingStatus", "failureClass"] as const)
        if (grade[key] !== checked[key]) throw new Error("Signal criterion summary differs from its evidence.");
    }
  }
  const groups = plan.tasks.map(task => {
    const attempts = result.cases.filter(item => item.taskId === task.id);
    const scored = attempts.filter(item => item.status === "completed" && item.grade?.gradingStatus === "scored"
      && item.grade.rewardEligible && item.grade.score !== null);
    const combined = scoreDistribution(scored.map(item => item.grade!.score!));
    const scoredFraction = scored.length / attempts.length;
    const components = plan.graders.map(spec => ({ id: spec.id, weight: spec.weight,
      distribution: scoreDistribution(scored.flatMap(item => item.grade!.grades.flatMap(grade => grade.components)
        .filter(component => component.graderId === spec.id && component.rewardEligible && component.score !== null)
        .map(component => component.score!))) }));
    return { taskId: task.id, family: task.family, attempts: attempts.length, eligible: scored.length, scoredFraction, combined, components,
      constant: combined.spread !== null && combined.spread <= Number.EPSILON,
      uniqueOutputs: new Set(attempts.filter(item => item.output !== null).map(item => contentHash(item.output))).size,
      informative: scoredFraction >= plan.thresholds.minimumScoredFraction && (combined.spread ?? 0) >= plan.thresholds.minimumSpread,
      outcomes: attempts.map(item => ({ receiptId: item.receiptId, seed: item.seed, status: item.status,
        gradingStatus: item.grade?.gradingStatus ?? null, failureClass: item.grade?.failureClass ?? null,
        rewardEligible: item.grade?.rewardEligible ?? false, score: item.grade?.score ?? null })) };
  });
  const informativeFamilies = [...new Set(groups.filter(group => group.informative).map(group => group.family))];
  const blockers: string[] = [];
  if (execution.status !== "completed" || !execution.cleanupComplete) blockers.push("execution_or_local_cleanup_incomplete");
  if (execution.usage.uncertainRequests || execution.usage.costUsd === null || execution.usage.heldUsd) blockers.push("cost_or_reservations_unsettled");
  if (groups.some(group => group.scoredFraction < plan.thresholds.minimumScoredFraction)) blockers.push("insufficient_scored_coverage");
  if (informativeFamilies.length < plan.thresholds.minimumInformativeFamilies) blockers.push("insufficient_within_prompt_signal");
  const body = { schemaVersion: "openpond.experimentSignalReport.v1", planHash: plan.contentHash, resultHash: result.contentHash,
    executionId: execution.id, model: execution.model, thresholds: plan.thresholds, groups, informativeFamilies,
    usage: execution.usage, cleanupComplete: execution.cleanupComplete, blockers, signalObserved: blockers.length === 0,
    trainingAuthorized: false, runtimeParityVerified: false,
    limitations: ["Offline hashes bind supplied evidence; they do not authenticate it or prove source-family independence. Full grade evidence hashes require the retained trace/artifacts to independently reconstruct.",
      "Local signal does not prove learner identity, GPU runtime/tokenizer parity, no-update behavior or provider deletion.",
      "Review rates, private gold, fixture calibration, family exposure and the unchanged-parent noise control before training."] };
  return { ...body, contentHash: contentHash(body) };
}
