import type { HarnessEvaluationReviewModelStream, LocalHarnessRefinerModelStream } from
  "@openpond/harness";
import { streamOpenPondHostedChatTurn } from "@openpond/runtime";

import type { TasksetWorkModelStream } from
  "../../../apps/server/src/training/taskset-work-attempt-runner.js";
import {
  HARNESS_REFINER_QUALIFICATION_LIMITS,
  HARNESS_REFINER_QUALIFICATION_MODEL,
  HARNESS_REFINER_QUALIFICATION_PRICING,
} from "./protocol.js";

export type QualificationUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
};

export class QualificationModelMeter {
  readonly usage: QualificationUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    requestCount: 0,
  };
  #requestOrdinal = 0;

  readonly workStream: TasksetWorkModelStream = async function* (
    this: QualificationModelMeter,
    input: Parameters<TasksetWorkModelStream>[0],
  ) {
    const requestId = this.requestId("work", input.requestId);
    for await (const delta of streamOpenPondHostedChatTurn({
      model: HARNESS_REFINER_QUALIFICATION_MODEL.modelId,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      requestId,
      reasoningEffort: input.reasoningEffort === "none"
        ? undefined
        : input.reasoningEffort ?? undefined,
      maxTokens: Math.min(
        input.maxOutputTokens ?? HARNESS_REFINER_QUALIFICATION_LIMITS.foregroundMaxOutputTokens,
        HARNESS_REFINER_QUALIFICATION_LIMITS.foregroundMaxOutputTokens,
      ),
      temperature: input.temperature,
      topP: input.topP,
      signal: input.signal,
    })) {
      if (delta.type === "text_delta" && delta.text) yield { text: delta.text };
      if (delta.type === "tool_call_delta") yield { toolCalls: delta.toolCalls };
      if (delta.type === "continuation") yield { continuation: delta.continuation };
      if (delta.type === "usage") {
        this.record(delta.usage);
        yield { usage: delta.usage };
      }
    }
  }.bind(this);

  readonly refinerStream: LocalHarnessRefinerModelStream = async function* (
    this: QualificationModelMeter,
    input: Parameters<LocalHarnessRefinerModelStream>[0],
  ) {
    for await (const delta of streamOpenPondHostedChatTurn({
      model: HARNESS_REFINER_QUALIFICATION_MODEL.modelId,
      messages: input.messages,
      requestId: this.requestId("refiner"),
      reasoningEffort: "low",
      maxTokens: HARNESS_REFINER_QUALIFICATION_LIMITS.refinerMaxOutputTokens,
      signal: input.signal,
    })) {
      if (delta.type === "text_delta" && delta.text) yield { text: delta.text };
      if (delta.type === "usage") this.record(delta.usage);
    }
  }.bind(this);

  readonly reviewStream: HarnessEvaluationReviewModelStream = async function* (
    this: QualificationModelMeter,
    input: Parameters<HarnessEvaluationReviewModelStream>[0],
  ) {
    for await (const delta of streamOpenPondHostedChatTurn({
      model: HARNESS_REFINER_QUALIFICATION_MODEL.modelId,
      messages: input.messages,
      requestId: this.requestId("review"),
      reasoningEffort: "low",
      maxTokens: HARNESS_REFINER_QUALIFICATION_LIMITS.reviewMaxOutputTokens,
      signal: input.signal,
    })) {
      if (delta.type === "text_delta" && delta.text) yield { text: delta.text };
      if (delta.type === "usage") this.record(delta.usage);
    }
  }.bind(this);

  snapshot(): QualificationUsage {
    return { ...this.usage };
  }

  private requestId(kind: string, suffix = ""): string {
    this.usage.requestCount += 1;
    this.#requestOrdinal += 1;
    return `harness-refiner-qualification:${kind}:${this.#requestOrdinal}:${suffix}`.slice(0, 240);
  }

  private record(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    const inputTokens = token(value, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"]);
    const outputTokens = token(value, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens"]);
    const totalTokens = token(value, ["totalTokens", "total_tokens"])
      || inputTokens + outputTokens;
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;
    this.usage.totalTokens += totalTokens;
    this.usage.estimatedCostUsd += (
      inputTokens * HARNESS_REFINER_QUALIFICATION_PRICING.inputUsdPerMillionTokens
      + outputTokens * HARNESS_REFINER_QUALIFICATION_PRICING.outputUsdPerMillionTokens
    ) / 1_000_000;
    if (
      this.usage.estimatedCostUsd
      > HARNESS_REFINER_QUALIFICATION_LIMITS.maximumSpendUsd
    ) {
      throw new Error("Harness Refiner qualification exceeded its admitted spend ceiling.");
    }
  }
}

function token(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}
