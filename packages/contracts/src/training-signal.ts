import type { BaselineReport } from "./tasksets.js";

type BaselineScope = NonNullable<BaselineReport["scope"]>;

export type RftSignalScopeMatch = Pick<
  BaselineScope,
  | "split"
  | "taskCount"
  | "attemptsPerTask"
  | "selectionSeed"
  | "selectionStrategy"
  | "model"
  | "sampling"
>;

export function selectPreferredRftSignalReport(
  reports: BaselineReport[],
  match: RftSignalScopeMatch,
): BaselineReport | null {
  let preferred: BaselineReport | null = null;
  for (const candidate of reports) {
    if (!matchesRftSignalScope(candidate, match)) continue;
    if (!preferred || preferRftSignalReport(candidate, preferred)) {
      preferred = candidate;
    }
  }
  return preferred;
}

function matchesRftSignalScope(
  report: BaselineReport,
  match: RftSignalScopeMatch,
): boolean {
  const scope = report.scope;
  return Boolean(
    scope
    && report.rftSignal
    && scope.split === match.split
    && scope.taskCount === match.taskCount
    && scope.attemptsPerTask === match.attemptsPerTask
    && scope.selectionSeed === match.selectionSeed
    && scope.selectionStrategy === match.selectionStrategy
    && scope.model.providerId === match.model.providerId
    && scope.model.modelId === match.model.modelId
    && scope.sampling.maxOutputTokens === match.sampling.maxOutputTokens
    && scope.sampling.temperature === match.sampling.temperature
    && scope.sampling.topP === match.sampling.topP,
  );
}

function preferRftSignalReport(
  candidate: BaselineReport,
  current: BaselineReport,
): boolean {
  const candidatePassed = candidate.rftSignal?.passed === true;
  const currentPassed = current.rftSignal?.passed === true;
  if (candidatePassed !== currentPassed) return candidatePassed;
  return candidate.createdAt > current.createdAt;
}
