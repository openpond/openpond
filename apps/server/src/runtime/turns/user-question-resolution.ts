import { SessionUserQuestionResolutionSchema, type SessionUserQuestionResolution } from "@openpond/contracts/user-questions";
import type { RuntimeEvent } from "@openpond/contracts/runtime";

export function parseUserQuestionResolution(
  value: unknown,
  priorEvents: RuntimeEvent[]
): SessionUserQuestionResolution | null {
  if (value === undefined) return null;
  const parsed = SessionUserQuestionResolutionSchema.parse(value);
  const asked = priorEvents.find((runtimeEvent) => {
    if (runtimeEvent.name !== "user_question.asked") return false;
    const data =
      runtimeEvent.data &&
      typeof runtimeEvent.data === "object" &&
      !Array.isArray(runtimeEvent.data)
        ? (runtimeEvent.data as Record<string, unknown>)
        : null;
    const question =
      data?.question &&
      typeof data.question === "object" &&
      !Array.isArray(data.question)
        ? (data.question as Record<string, unknown>)
        : null;
    return question?.id === parsed.questionId;
  });
  if (!asked)
    throw new Error(`Pending user question not found: ${parsed.questionId}`);
  const alreadyResolved = priorEvents.some((runtimeEvent) => {
    if (
      runtimeEvent.name !== "user_question.answered" &&
      runtimeEvent.name !== "user_question.dismissed"
    ) {
      return false;
    }
    const data =
      runtimeEvent.data &&
      typeof runtimeEvent.data === "object" &&
      !Array.isArray(runtimeEvent.data)
        ? (runtimeEvent.data as Record<string, unknown>)
        : null;
    const resolution =
      data?.resolution &&
      typeof data.resolution === "object" &&
      !Array.isArray(data.resolution)
        ? (data.resolution as Record<string, unknown>)
        : null;
    return resolution?.questionId === parsed.questionId;
  });
  if (alreadyResolved)
    throw new Error(`User question is already resolved: ${parsed.questionId}`);

  const askedData =
    asked.data && typeof asked.data === "object" && !Array.isArray(asked.data)
      ? (asked.data as Record<string, unknown>)
      : {};
  const askedQuestion =
    askedData.question &&
    typeof askedData.question === "object" &&
    !Array.isArray(askedData.question)
      ? (askedData.question as Record<string, unknown>)
      : {};
  const options = Array.isArray(askedQuestion.options)
    ? askedQuestion.options
    : [];
  if (
    parsed.action === "answer" &&
    parsed.optionId &&
    !options.some(
      (option) =>
        option &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        (option as Record<string, unknown>).id === parsed.optionId
    )
  ) {
    throw new Error(`Question option not found: ${parsed.optionId}`);
  }
  if (parsed.action === "answer" && !parsed.text && !parsed.optionId) {
    throw new Error("A user-question answer requires text or an option.");
  }
  return parsed;
}

export function promptWithUserQuestionResolution(
  prompt: string,
  resolution: SessionUserQuestionResolution | null
): string {
  if (!resolution) return prompt;
  const structured =
    resolution.action === "answer"
      ? [
          `The user explicitly answered pending question ${resolution.questionId}.`,
          resolution.optionId
            ? `Selected option ID: ${resolution.optionId}.`
            : null,
          resolution.text ? `Answer: ${resolution.text}` : null,
          "Continue the same task using this answer.",
        ]
      : [
          `The user explicitly dismissed pending question ${resolution.questionId}.`,
          "Continue only if the task can proceed safely without that answer; otherwise explain the blocker.",
        ];
  return `${prompt}\n\n[OpenPond question resolution]\n${structured
    .filter(Boolean)
    .join("\n")}`;
}

