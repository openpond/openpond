import { canonicalJson } from "./protocol.js";
import {
  parseAndVerifyActivationReferenceRequest,
  parseAndVerifyActivationReferenceResult,
  type ActivationReferenceRequest,
  type ActivationReferenceResult,
} from "./activation-reference.js";

export type ActivationComparisonVariant = ActivationReferenceRequest["variants"][number];
type Capture = ActivationReferenceResult["captures"][number];

const difference = (candidate: number, reference: number) => {
  const value = candidate - reference;
  return Number.isFinite(value) ? value : null;
};

/** A dose difference is meaningful only when all other intervention inputs agree. */
export function activationDoseComparison(
  reference: ActivationComparisonVariant,
  candidate: ActivationComparisonVariant,
) {
  const a = reference.profile,
    b = candidate.profile;
  const settings = (profile: NonNullable<ActivationComparisonVariant["profile"]>) => {
    const { entries, contentHash: _, ...rest } = profile;
    return canonicalJson({
      ...rest,
      coordinates: entries.map(({ layer, neuron }) => `${layer}:${neuron}`).sort(),
    });
  };
  const reason =
    a && b && settings(a) !== settings(b)
      ? "Dose differences unavailable: model, hook, normalization, token scope or targeted coordinates differ."
      : null;
  const coordinates = new Map<
    string,
    { layer: number; neuron: number; reference: number | null; candidate: number | null }
  >();
  for (const [profile, side] of [
    [a, "reference"],
    [b, "candidate"],
  ] as const) {
    for (const entry of profile?.entries ?? []) {
      const key = `${entry.layer}:${entry.neuron}`;
      const row = coordinates.get(key) ?? {
        layer: entry.layer,
        neuron: entry.neuron,
        reference: a === null ? 0 : null,
        candidate: b === null ? 0 : null,
      };
      row[side] = entry.dose;
      coordinates.set(key, row);
    }
  }
  return {
    reason,
    rows: [...coordinates.values()]
      .sort((x, y) => x.layer - y.layer || x.neuron - y.neuron)
      .map((row) => ({
        ...row,
        difference:
          !reason && row.reference !== null && row.candidate !== null
            ? difference(row.candidate, row.reference)
            : null,
      })),
  };
}

/** Both inputs are from the same SDK-verified request/result. Never align a
 * generated capture after its causal token prefix diverges, even if it rejoins. */
export function activationResultComparison(
  request: ActivationReferenceRequest,
  result: ActivationReferenceResult,
  referenceId: string,
  candidateId: string,
  promptId: string | null,
) {
  const captureKey = (row: Pick<Capture, "promptId" | "tokenIndex" | "layer" | "neuron">) =>
    JSON.stringify([row.promptId, row.tokenIndex, row.layer, row.neuron]);
  const referenceCaptures = new Map<string, Capture>(),
    candidateCaptures = new Map<string, Capture>();
  for (const row of result.captures) {
    if (row.variantId === referenceId) referenceCaptures.set(captureKey(row), row);
    if (row.variantId === candidateId) candidateCaptures.set(captureKey(row), row);
  }
  const outcomes = new Map(
    result.outcomes.map((row) => [JSON.stringify([row.promptId, row.variantId]), row]),
  );
  const prompts = request.prompts.filter((row) => promptId === null || row.id === promptId);
  const pairs = prompts.map((prompt) => {
    const reference = outcomes.get(JSON.stringify([prompt.id, referenceId])),
      candidate = outcomes.get(JSON.stringify([prompt.id, candidateId]));
    const inputTokenIds = prompt.tokenIds.filter((_, index) => prompt.attentionMask[index] === 1);
    const a = reference ? inputTokenIds.concat(reference.generatedTokenIds) : [],
      b = candidate ? inputTokenIds.concat(candidate.generatedTokenIds) : [];
    let sharedPrefix = 0;
    while (sharedPrefix < Math.min(a.length, b.length) && a[sharedPrefix] === b[sharedPrefix])
      sharedPrefix++;
    const generatedPrefix = Math.max(0, sharedPrefix - inputTokenIds.length);
    const generatedStatus: "missing_outcome" | "identical" | "different" =
      !reference || !candidate
        ? "missing_outcome"
        : reference.generatedTokenIds.length === candidate.generatedTokenIds.length &&
            generatedPrefix === reference.generatedTokenIds.length
          ? "identical"
          : "different";
    return {
      prompt,
      reference,
      candidate,
      inputTokenIds,
      referenceTokenIds: a,
      candidateTokenIds: b,
      sharedPrefix,
      generatedStatus,
      generatedDifferencePosition: generatedStatus === "different" ? generatedPrefix : null,
    };
  });
  const captures = pairs.flatMap((pair) => {
    // Enumerate requested coordinates as well as retained captures so absence
    // cannot disappear from the comparison table.
    const length = Math.max(
      pair.referenceTokenIds.length,
      pair.candidateTokenIds.length,
      pair.inputTokenIds.length,
    );
    const rows = [];
    for (let tokenIndex = 0; tokenIndex < length; tokenIndex++)
      for (const coordinate of request.capture)
        for (const neuron of coordinate.neurons) {
          const key = captureKey({
            promptId: pair.prompt.id,
            tokenIndex,
            layer: coordinate.layer,
            neuron,
          });
          const reference = referenceCaptures.get(key),
            candidate = candidateCaptures.get(key);
          const status: ActivationCaptureAlignment =
            !reference || !candidate
              ? !reference && !candidate
                ? "missing_both"
                : !reference
                  ? "missing_reference"
                  : "missing_candidate"
              : tokenIndex >= pair.sharedPrefix
                ? "incompatible_context"
                : "aligned";
          rows.push({
            key,
            promptId: pair.prompt.id,
            tokenIndex,
            phase: tokenIndex < pair.inputTokenIds.length ? "Prompt" : "Generated",
            layer: coordinate.layer,
            neuron,
            reference,
            candidate,
            status,
            difference:
              status === "aligned" ? difference(candidate!.after, reference!.after) : null,
          });
        }
    return rows;
  });
  return { pairs, captures, aligned: captures.filter((row) => row.status === "aligned").length };
}

/** Headless entry point for untrusted retained bytes. Console uses the pure
 * projection after its existing execution client has already verified them. */
export async function verifyAndCompareActivationReferenceResult(
  request: ActivationReferenceRequest,
  raw: unknown,
  referenceId: string,
  candidateId: string,
  promptId: string | null = null,
) {
  const input = await parseAndVerifyActivationReferenceRequest(request);
  const result = await parseAndVerifyActivationReferenceResult(raw, input);
  return activationResultComparison(input, result, referenceId, candidateId, promptId);
}

export type ActivationCaptureAlignment =
  | "aligned"
  | "incompatible_context"
  | "missing_reference"
  | "missing_candidate"
  | "missing_both";
export type ActivationResultComparison = ReturnType<typeof activationResultComparison>;
export type ActivationDoseComparison = ReturnType<typeof activationDoseComparison>;
