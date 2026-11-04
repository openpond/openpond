import {
  activationDoseComparison,
  verifyAndCompareActivationReferenceResult,
  type createTrainingClient,
} from "openpond-sdk/training";

/** Read the existing canonical execution once. Comparison grants no execution,
 * publication or funding authority and never depends on a local app server. */
export async function compareHostedModification(input: {
  client: Pick<ReturnType<typeof createTrainingClient>, "getModificationExecution">;
  teamId: string;
  executionId: string;
  baselineId: string;
  candidateId: string;
  promptId?: string;
}) {
  if (!input.executionId || !input.baselineId || !input.candidateId)
    throw new Error(
      "hosted-compare-modification requires an execution ID, --baseline <variant-id> and --candidate <variant-id>.",
    );
  if (input.baselineId === input.candidateId)
    throw new Error("Choose two different variant IDs for --baseline and --candidate.");
  const execution = await input.client.getModificationExecution(input.teamId, input.executionId);
  const baseline = execution.request.variants.find((row) => row.id === input.baselineId);
  const candidate = execution.request.variants.find((row) => row.id === input.candidateId);
  if (!baseline || !candidate)
    throw new Error("The comparison variants must both belong to this exact execution request.");
  if (input.promptId && !execution.request.prompts.some((row) => row.id === input.promptId))
    throw new Error("The selected prompt must belong to this exact execution request.");
  const comparison = execution.result
    ? await verifyAndCompareActivationReferenceResult(
        execution.request,
        execution.result,
        baseline.id,
        candidate.id,
        input.promptId ?? null,
      )
    : null;
  return {
    execution: {
      id: execution.id,
      teamId: execution.teamId,
      phase: execution.phase,
      revision: execution.revision,
      planHash: execution.plan.contentHash,
      requestHash: execution.result?.requestHash ?? null,
      modelHash: execution.result?.modelHash ?? null,
      resultHash: execution.result?.contentHash ?? null,
    },
    baseline: { id: baseline.id, profileHash: baseline.profile?.contentHash ?? null },
    candidate: { id: candidate.id, profileHash: candidate.profile?.contentHash ?? null },
    promptId: input.promptId ?? null,
    state: comparison === null ? ("unavailable" as const) : ("available" as const),
    reason:
      comparison === null
        ? "This verified execution read contains no retained capture artifact."
        : null,
    doses: activationDoseComparison(baseline, candidate),
    comparison,
  };
}

export function printHostedModificationComparison(
  value: Awaited<ReturnType<typeof compareHostedModification>>,
  json: boolean,
) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const id = (text: string) => JSON.stringify(text);
  console.log(`Execution ${id(value.execution.id)} · ${value.execution.phase}`);
  console.log(`Reference ${id(value.baseline.id)} → candidate ${id(value.candidate.id)}`);
  console.log(
    "Differences are candidate minus reference. Capture availability does not establish cleanup or settlement; no quality grade is assigned.",
  );
  if (!value.comparison) {
    console.log(value.reason);
    return;
  }
  console.log(`Result hash: ${value.execution.resultHash}`);
  console.log(
    `Aligned coordinate captures: ${value.comparison.aligned} / ${value.comparison.captures.length}`,
  );
  for (const pair of value.comparison.pairs) {
    console.log(
      `Prompt ${id(pair.prompt.id)}: ${pair.generatedStatus === "identical" ? "identical generated token sequence" : pair.generatedStatus === "missing_outcome" ? "missing retained outcome" : `first generated sequence difference at position ${pair.generatedDifferencePosition} (zero-based)`}.`,
    );
  }
  if (value.doses.reason) console.log(value.doses.reason);
  for (const row of value.doses.rows)
    console.log(
      `Layer ${row.layer}, neuron ${row.neuron}: requested dose ${row.reference ?? "unavailable"} → ${row.candidate ?? "unavailable"}; difference ${row.difference ?? "unavailable"}.`,
    );
  console.log(
    "Use --json for original prompt tokens/masks, retained outputs, before/after values and per-coordinate missing/incompatible evidence.",
  );
}
