import { z } from "zod";
import { DecisionExperimentFormDraftSchema, DecisionModelScoreRequestSchema } from "openpond-sdk/training";

// Retain unfinished authoring without mixing it into a free-form chat draft.
export const DecisionChatDraftSchema = DecisionExperimentFormDraftSchema.options[1].pick({
  stateJson: true, questions: true, limits: true,
});
export type DecisionChatDraft = z.infer<typeof DecisionChatDraftSchema>;
export const DecisionChatDraftsSchema = z.record(z.string().regex(/^managed-decision:[a-f0-9]{64}$/), DecisionChatDraftSchema);
export const DecisionChatInputSchema = DecisionModelScoreRequestSchema.pick({ input: true, limits: true });

export function isDecisionChatModel(provider: string, model: string | null | undefined) {
  return provider === "openpond" && model?.startsWith("managed-decision:") === true;
}

export function decisionChatDraftFromInput(raw: unknown): DecisionChatDraft {
  const value = DecisionChatInputSchema.parse(raw);
  return DecisionChatDraftSchema.parse({
    stateJson: JSON.stringify(value.input.state, null, 2),
    questions: value.input.questions.map(question => ({ ...question,
      choices: question.choices.map(choice => ({ ...choice, value: String(choice.value) })),
    })),
    limits: Object.fromEntries(Object.entries(value.limits).map(([key, value]) => [key, String(value)])),
  });
}

/** The stored/provider prompt stays typed JSON. The transcript displays the
 * same authored state/questions without exposing its transport envelope. */
export function decisionChatPromptForDisplay(provider: string, model: string | null | undefined, prompt: string): string {
  if (!isDecisionChatModel(provider, model) || new TextEncoder().encode(prompt).byteLength > 131_072) return prompt;
  try {
    const { input } = DecisionChatInputSchema.parse(JSON.parse(prompt));
    const escape = (text: unknown) => String(text).replace(/[\\`*_[\]<>|]/g, character => `\\${character}`).replace(/[\r\n]+/g, " ");
    return [
      ...input.questions.flatMap(question => [escape(question.description),
        ...question.choices.map(choice => `- ${escape(choice.value)}: ${escape(choice.description)}`), ""]),
      "Context:", "", ...JSON.stringify(input.state, null, 2).split("\n").map(line => `    ${line}`),
    ].join("\n").trim();
  } catch { return prompt; }
}
