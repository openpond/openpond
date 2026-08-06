import type { Experience, OutputRef } from "@openpond/contracts";

export type ExperienceHandoffMetadata = {
  sourceTaskId: string;
  sourceExperience: Experience | null;
  targetExperience: Experience;
  sourceMessageIds: string[];
  sourceContext: string | null;
  outputId: string | null;
  outputRevision: number | null;
  createdAt: string;
  checkoutMutation: "none";
};

export function buildExperienceHandoffMetadata(input: {
  sourceTaskId: string;
  sourceExperience: Experience | null;
  targetExperience: Experience;
  sourceMessageIds?: string[];
  sourceContext?: string;
  output?: Pick<OutputRef, "id" | "revision">;
  createdAt?: string;
}): ExperienceHandoffMetadata {
  return {
    sourceTaskId: input.sourceTaskId,
    sourceExperience: input.sourceExperience,
    targetExperience: input.targetExperience,
    sourceMessageIds: [...(input.sourceMessageIds ?? [])],
    sourceContext: input.sourceContext?.trim() || null,
    outputId: input.output?.id ?? null,
    outputRevision: input.output?.revision ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    checkoutMutation: "none",
  };
}

export function exactExchangeHandoffContext(
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>
): string {
  return messages
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`
    )
    .join("\n\n");
}

export function exactExchangeHandoffPrompt(
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>
): string {
  const context = exactExchangeHandoffContext(messages);
  return `Continue this exact exchange in Work:\n\n${context}`;
}

export function outputHandoffPrompt(
  output: Pick<OutputRef, "revision" | "title">,
  target: Extract<Experience, "chat" | "work">
): string {
  const base = `Continue from the attached Work output "${output.title}" (revision ${output.revision}).`;
  return target === "work"
    ? `${base} Choose a Project or repository before making source changes; do not mutate a checkout until I choose it.`
    : base;
}
