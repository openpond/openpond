import type { HostedChatImageInput } from "@openpond/cloud";
import type { ChatModelRef } from "@openpond/contracts";
import {
  createPreferenceReceipt,
  type ComparisonAssignment,
  type PreferenceComparisonRelease,
  type PreferenceReceipt,
  type PreferenceReviewer,
} from "@openpond/evals";

import type { createTrainingModelRuntime } from "./training-model-runtime.js";

type TrainingModelText = ReturnType<typeof createTrainingModelRuntime>["trainingModelText"];

export type PreferenceComparisonVisualCandidate = {
  attemptId: string;
  images: HostedChatImageInput[];
};

export type PreferenceModelJudgeOutcome =
  | {
      status: "scored";
      receipt: PreferenceReceipt;
      usage: unknown[];
      costUsd: number;
    }
  | {
      status: "unscorable";
      code:
        | "artifact_load_failed"
        | "native_visual_evidence_missing"
        | "judge_cancelled"
        | "judge_timed_out"
        | "judge_transport_failed"
        | "judge_response_invalid"
        | "receipt_validation_failed";
      failureOwner: "artifact" | "caller" | "model_provider" | "model_output" | "portable_contract";
      reason: string;
      usage: unknown[];
      costUsd: number;
    };

const MODEL_REVIEW_TIMEOUT_MS = 90_000;

/**
 * Runs an automated preference reviewer over the exact presentation candidates.
 * Image-bearing releases fail closed when every candidate cannot be delivered as
 * native image inputs. That boundary keeps unavailable vision evidence from
 * becoming an accidental metadata-only aesthetic score.
 */
export function createPreferenceComparisonModelJudge(deps: {
  modelText: TrainingModelText;
  loadVisualCandidates(input: {
    assignment: ComparisonAssignment;
    comparisonRelease: PreferenceComparisonRelease;
  }): Promise<PreferenceComparisonVisualCandidate[]>;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function judge(input: {
    id: string;
    assignment: ComparisonAssignment;
    comparisonRelease: PreferenceComparisonRelease;
    reviewer: PreferenceReviewer;
    model: ChatModelRef;
    rubric: string;
    taskPrompt?: string | null;
    presentedCandidateOrder?: readonly string[];
    signal: AbortSignal;
  }): Promise<PreferenceModelJudgeOutcome> {
    const usages: unknown[] = [];
    let costUsd = 0;
    const requiresImages = input.comparisonRelease.presentation.parts.some(
      (part) => part.renderer === "image",
    );
    let candidates: PreferenceComparisonVisualCandidate[] = [];
    try {
      candidates = await deps.loadVisualCandidates({
        assignment: input.assignment,
        comparisonRelease: input.comparisonRelease,
      });
    } catch (error) {
      return unscorable("artifact_load_failed", "artifact", `Visual artifact loading failed: ${errorMessage(error)}`, usages, costUsd);
    }
    const imageByAttempt = new Map(candidates.map((candidate) => [candidate.attemptId, candidate.images]));
    if (requiresImages) {
      const missing = input.assignment.candidates.filter(
        (candidate) => !imageByAttempt.get(candidate.attemptRef.id)?.length,
      );
      if (missing.length) {
        return unscorable(
          "native_visual_evidence_missing",
          "artifact",
          "Native visual evidence is unavailable for one or more presented candidates.",
          usages,
          costUsd,
        );
      }
    }

    const presentedCandidateOrder = input.presentedCandidateOrder
      ? validatePresentedCandidateOrder(input.assignment, input.presentedCandidateOrder)
      : input.assignment.presentedCandidateOrder;
    const presentation = presentedCandidateOrder.map((attemptId, index) => ({
      label: `candidate-${index + 1}`,
      attemptId,
      images: imageByAttempt.get(attemptId) ?? [],
    }));
    const imageInputs = presentation.flatMap((candidate) => candidate.images);
    const startedAt = now();
    let raw: string;
    const timeoutSignal = AbortSignal.timeout(MODEL_REVIEW_TIMEOUT_MS);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    try {
      raw = await deps.modelText({
        model: input.model,
        signal,
        requestId: `preference-model-judge:${input.assignment.id}:${input.id}`,
        maxOutputTokens: 1_200,
        temperature: 0,
        onUsage: (usage, cost) => {
          usages.push(usage);
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) costUsd += cost;
        },
        messages: [
          {
            role: "system",
            content: preferenceJudgeSystemPrompt(input.rubric, input.comparisonRelease),
          },
          {
            role: "user",
            content: preferenceJudgeUserPrompt({
              taskPrompt: input.comparisonRelease.presentation.showTaskPrompt
                ? input.taskPrompt ?? null
                : null,
              presentation,
            }),
            ...(imageInputs.length ? { images: imageInputs } : {}),
          },
        ],
      });
    } catch (error) {
      const timedOut = timeoutSignal.aborted && !input.signal.aborted;
      return unscorable(
        timedOut ? "judge_timed_out" : input.signal.aborted ? "judge_cancelled" : "judge_transport_failed",
        timedOut || input.signal.aborted ? "caller" : "model_provider",
        timedOut
          ? `Model reviewer exceeded the ${MODEL_REVIEW_TIMEOUT_MS / 1_000}-second deadline.`
          : input.signal.aborted
            ? "Model review was cancelled by the caller."
            : `Model reviewer did not produce a usable response: ${errorMessage(error)}`,
        usages,
        costUsd,
      );
    }
    let judgment: ParsedPreferenceJudgment;
    try {
      judgment = parsePreferenceModelJudgment(raw, presentation.map((candidate) => candidate.label));
    } catch (error) {
      return unscorable("judge_response_invalid", "model_output", `Model reviewer returned invalid ranking JSON: ${errorMessage(error)}`, usages, costUsd);
    }
    try {
      const receipt = createPreferenceReceipt({
        id: input.id,
        assignment: input.assignment,
        comparisonRelease: input.comparisonRelease,
        reviewer: input.reviewer,
        order: judgment.rejectAll
          ? []
          : judgment.order.map((group) => group.map((label) => presentation.find((candidate) => candidate.label === label)!.attemptId)),
        rejectAll: judgment.rejectAll,
        ...(judgment.criterionScores
          ? {
              criterionScores: Object.fromEntries(
                Object.entries(judgment.criterionScores).map(([label, scores]) => [
                  presentation.find((candidate) => candidate.label === label)!.attemptId,
                  scores,
                ]),
              ),
            }
          : {}),
        startedAt,
        completedAt: now(),
      });
      return { status: "scored", receipt, usage: usages, costUsd };
    } catch (error) {
      return unscorable("receipt_validation_failed", "portable_contract", `Model reviewer receipt failed verification: ${errorMessage(error)}`, usages, costUsd);
    }
  }

  return { judge };
}

type ParsedPreferenceJudgment = {
  order: string[][];
  rejectAll: boolean;
  criterionScores?: Record<string, Record<string, number>>;
};

export function parsePreferenceModelJudgment(
  raw: string,
  candidateLabels: readonly string[],
): ParsedPreferenceJudgment {
  const parsed = JSON.parse(jsonObjectFromText(raw)) as Record<string, unknown>;
  const rejectAll = parsed.rejectAll === true;
  const order = Array.isArray(parsed.order)
    ? parsed.order.map((group) => {
        if (!Array.isArray(group) || !group.every((label) => typeof label === "string")) {
          throw new Error("order must be an array of candidate-label groups.");
        }
        return group;
      })
    : [];
  if (!rejectAll) {
    const flattened = order.flat();
    if (flattened.length !== candidateLabels.length || new Set(flattened).size !== candidateLabels.length) {
      throw new Error("order must rank every presented candidate exactly once.");
    }
    if (flattened.some((label) => !candidateLabels.includes(label))) {
      throw new Error("order includes an unknown presentation candidate.");
    }
  } else if (order.length) {
    throw new Error("reject-all judgments must not include a ranking.");
  }
  const criterionScores = parseCriterionScores(parsed.criterionScores, candidateLabels);
  return { order, rejectAll, ...(criterionScores ? { criterionScores } : {}) };
}

function preferenceJudgeSystemPrompt(
  rubric: string,
  release: PreferenceComparisonRelease,
): string {
  return [
    "You are a calibrated preference reviewer. Apply the supplied rubric only to the presented candidates.",
    "Do not infer model identity, rarity, or hidden metadata. Rank visual appearance from the native images when images are present.",
    "Return JSON only: {\"order\":[[\"candidate-1\"],[\"candidate-2\"]],\"rejectAll\":false,\"criterionScores\":{\"candidate-1\":{\"criterion-id\":0.9}}}.",
    release.allowRejectAll
      ? "Use rejectAll=true with an empty order only if every candidate is unacceptably poor under the rubric."
      : "rejectAll must be false.",
    `Rubric:\n${rubric}`,
  ].join("\n\n");
}

function preferenceJudgeUserPrompt(input: {
  taskPrompt: string | null;
  presentation: Array<{ label: string; attemptId: string; images: HostedChatImageInput[] }>;
}): string {
  return JSON.stringify({
    ...(input.taskPrompt ? { taskPrompt: input.taskPrompt } : {}),
    candidates: input.presentation.map((candidate, index) => ({
      label: candidate.label,
      imageIndexes: candidate.images.map((_, imageIndex) => imageIndex + 1 + input.presentation.slice(0, index).reduce((total, prior) => total + prior.images.length, 0)),
    })),
  });
}

function parseCriterionScores(
  value: unknown,
  candidateLabels: readonly string[],
): Record<string, Record<string, number>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("criterionScores must be an object when supplied.");
  }
  const scores: Record<string, Record<string, number>> = {};
  for (const [label, scoreValue] of Object.entries(value as Record<string, unknown>)) {
    if (!candidateLabels.includes(label)) {
      throw new Error("criterionScores includes an unknown presentation candidate.");
    }
    if (!scoreValue || typeof scoreValue !== "object" || Array.isArray(scoreValue)) {
      throw new Error("criterionScores entries must map criterion IDs to numeric scores.");
    }
    const byCriterion: Record<string, number> = {};
    for (const [criterionId, score] of Object.entries(scoreValue as Record<string, unknown>)) {
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error("criterionScores includes an invalid criterion score.");
      }
      byCriterion[criterionId] = score;
    }
    scores[label] = byCriterion;
  }
  return scores;
}

function jsonObjectFromText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) return fenced;
  throw new Error("response was not a JSON object.");
}

function unscorable(
  code: Extract<PreferenceModelJudgeOutcome, { status: "unscorable" }>["code"],
  failureOwner: Extract<PreferenceModelJudgeOutcome, { status: "unscorable" }>["failureOwner"],
  reason: string,
  usage: unknown[],
  costUsd: number,
): PreferenceModelJudgeOutcome {
  return { status: "unscorable", code, failureOwner, reason, usage, costUsd };
}

function validatePresentedCandidateOrder(
  assignment: ComparisonAssignment,
  value: readonly string[],
): readonly string[] {
  const expected = assignment.candidates.map((candidate) => candidate.attemptRef.id);
  if (
    value.length !== expected.length
    || new Set(value).size !== expected.length
    || value.some((attemptId) => !expected.includes(attemptId))
  ) {
    throw new Error("Model-review presentation order must contain every assignment candidate exactly once.");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
