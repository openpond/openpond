import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { DecisionModelIdentitySchema, parseAndVerifyDecisionModelIdentity } from "./decision-model.js";
import { assertCanonicalPayloadSize, canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().min(1).max(2000).refine(value => value.trim().length > 0);
const Name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
  .refine(value => !["constructor", "prototype"].includes(value));
const Level = z.number().int().min(-1_000_000).max(1_000_000);
export const DecisionValueSchema = z.union([z.string().min(1).max(256), z.boolean(), Level]);
export const DecisionArtifactReferenceSchema = z.object({ id: z.string().min(1).max(500), contentHash: Hash }).strict();

export const DecisionStateSchema = z.record(z.string().max(256), z.json()).superRefine((value, context) => {
  try { assertBoundedTaskJson(value, 65_536); }
  catch { context.addIssue({ code: "custom", message: "Decision state must be bounded finite JSON of at most 64 KiB." }); }
});
const question = { id: Name, description: Text };
export const DecisionQuestionSchema = z.discriminatedUnion("type", [
  z.object({ ...question, type: z.literal("choice"), choices: z.array(z.object({
    value: z.string().min(1).max(256).refine(value => value.trim().length > 0), description: Text,
  }).strict()).min(2).max(26) }).strict(),
  z.object({ ...question, type: z.literal("boolean"), choices: z.tuple([
    z.object({ value: z.literal(false), description: Text }).strict(),
    z.object({ value: z.literal(true), description: Text }).strict(),
  ]) }).strict(),
  z.object({ ...question, type: z.literal("integer_levels"), choices: z.array(z.object({
    value: Level, description: Text,
  }).strict()).min(2).max(26) }).strict(),
]).superRefine((value, context) => {
  if (new Set(value.choices.map(choice => choice.value)).size !== value.choices.length)
    context.addIssue({ code: "custom", path: ["choices"], message: "Decision choices must be distinct." });
  if (value.type === "integer_levels" && value.choices.some((choice, index) => index > 0 && choice.value <= value.choices[index - 1]!.value))
    context.addIssue({ code: "custom", path: ["choices"], message: "Integer levels must retain strictly increasing authored order." });
});
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;
export const DecisionQuestionsSchema = z.array(DecisionQuestionSchema).min(1).max(8).superRefine((value, context) => {
  if (new Set(value.map(row => row.id)).size !== value.length)
    context.addIssue({ code: "custom", message: "Decision question names must be distinct." });
});
export const DecisionScoringInputSchema = z.object({ state: DecisionStateSchema, questions: DecisionQuestionsSchema }).strict();
export type DecisionScoringInput = z.infer<typeof DecisionScoringInputSchema>;
export const DecisionTrainingExampleSchema = DecisionScoringInputSchema.extend({
  id: z.string().min(1).max(500),
  targets: z.array(z.object({ questionId: Name, value: DecisionValueSchema }).strict()).min(1).max(8),
}).superRefine((value, context) => {
  if (value.targets.length !== value.questions.length || value.questions.some((row, index) => {
    const target = value.targets[index];
    return !target || target.questionId !== row.id || !row.choices.some(choice => choice.value === target.value);
  })) context.addIssue({ code: "custom", path: ["targets"], message: "Targets must match every named question and real choice in authored order." });
});
export type DecisionTrainingExample = z.infer<typeof DecisionTrainingExampleSchema>;

/** This is the raw reviewed-data projection, not training authorization. The
 * hosted owner must resolve the approved batch and verify these exact bytes. */
export const DecisionTrainingExamplesSchema = z.array(DecisionTrainingExampleSchema).min(1).max(4096)
  .superRefine((value, context) => {
    if (new Set(value.map(row => row.id)).size !== value.length)
      context.addIssue({ code: "custom", message: "Decision example IDs must be distinct." });
    try { assertCanonicalPayloadSize(value, 8_388_608, "Decision examples"); }
    catch { context.addIssue({ code: "custom", message: "Decision examples exceed the 8 MiB input boundary." }); }
  });

export async function parseAndVerifyDecisionTrainingExamples(raw: unknown, examplesSha256?: string) {
  assertBoundedTaskJson(raw, 8_388_608);
  const value = DecisionTrainingExamplesSchema.parse(raw);
  if (examplesSha256 !== undefined && Hash.parse(examplesSha256) !== await canonicalSha256(value))
    throw new OpenPondProtocolError("decision_examples_mismatch", "The decision examples differ from the exact reviewed projection digest.");
  return value;
}

/** Targets are deliberately absent. Pass this ordered schema to the pinned
 * prepare_prompts implementation; it checks actual answer-boundary tokens and
 * rejects overlong input instead of truncating. Integer levels are rendered as
 * enum strings and converted back to typed numbers only after scoring. */
export function decisionReferenceInput(raw: DecisionScoringInput) {
  assertBoundedTaskJson(raw, 131_072);
  const input = DecisionScoringInputSchema.parse(raw);
  const schema = Object.fromEntries(input.questions.map(row => [row.id, {
    type: row.type === "boolean" ? "boolean" : "enum",
    description: row.description,
    choices: row.choices.map(choice => row.type === "integer_levels" ? String(choice.value) : choice.value),
    choice_descriptions: Object.fromEntries(row.choices.map(choice => [String(choice.value), choice.description])),
  }]));
  return { context: canonicalJson(input.state), schema };
}

export const DecisionScoringRequestSchema = z.object({
  schemaVersion: z.literal("openpond.decisionScoringRequest.v1"),
  model: DecisionModelIdentitySchema,
  artifact: DecisionArtifactReferenceSchema.nullable(),
  input: DecisionScoringInputSchema,
  limits: z.object({
    maximumPromptTokens: z.number().int().min(1).max(2048),
    maximumForwardTokenWork: z.number().int().min(1).max(65_536),
    maximumDurationSeconds: z.number().finite().positive().max(300),
  }).strict(),
}).strict();
export type DecisionScoringRequest = z.infer<typeof DecisionScoringRequestSchema>;

export async function parseAndVerifyDecisionScoringRequest(raw: unknown) {
  assertBoundedTaskJson(raw, 131_072);
  const value = DecisionScoringRequestSchema.parse(raw);
  await parseAndVerifyDecisionModelIdentity(value.model);
  return value;
}

export const DecisionQuestionDistributionSchema = z.object({
  questionId: Name, promptTokenCount: z.number().int().min(1).max(2048),
  candidates: z.array(z.object({
    value: DecisionValueSchema, code: z.string().regex(/^[A-Z]$/),
    tokenId: z.number().int().min(0).max(248_319),
    logit: z.number().finite(), probability: z.number().finite().min(0).max(1),
  }).strict()).min(2).max(26),
  prediction: DecisionValueSchema,
  expectedLevel: z.number().finite().min(-1_000_000).max(1_000_000).nullable(),
}).strict();
export type DecisionQuestionDistribution = z.infer<typeof DecisionQuestionDistributionSchema>;
export const DecisionScoringResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionScoringResult.v1"),
  requestHash: Hash, modelHash: Hash, runtimeHash: Hash, preparedRowsHash: Hash,
  artifact: DecisionArtifactReferenceSchema.nullable(), temperature: z.literal(1),
  distributions: z.array(DecisionQuestionDistributionSchema).min(1).max(8),
  forwardTokenWork: z.number().int().positive().max(65_536),
  durationMs: z.number().finite().nonnegative().max(300_000),
}).strict();
export const DecisionScoringResultSchema = DecisionScoringResultContentSchema.extend({ contentHash: Hash });
export type DecisionScoringResult = z.infer<typeof DecisionScoringResultSchema>;

/** Verifies the arithmetic and exact request/runtime pin; it does not attest
 * that a producer actually executed the pinned model or measured these logits. */
export async function parseAndVerifyDecisionScoringResult(raw: unknown, expected: {
  request: DecisionScoringRequest; runtimeHash: string;
}) {
  assertBoundedTaskJson(raw, 131_072);
  const request = await parseAndVerifyDecisionScoringRequest(expected.request);
  const value = DecisionScoringResultSchema.parse(raw), { contentHash, ...content } = value;
  const fail = (): never => { throw new OpenPondProtocolError("decision_score_mismatch", "The decision distributions differ from the exact request, complete T1 candidate scores or runtime."); };
  if (contentHash !== await canonicalSha256(content) || value.requestHash !== await canonicalSha256(request)
    || value.modelHash !== await canonicalSha256(request.model) || value.runtimeHash !== Hash.parse(expected.runtimeHash)
    || canonicalJson(value.artifact) !== canonicalJson(request.artifact)
    || value.distributions.length !== request.input.questions.length
    || value.forwardTokenWork > request.limits.maximumForwardTokenWork
    || value.durationMs > request.limits.maximumDurationSeconds * 1000) fail();
  let promptWork = 0;
  for (const [index, question] of request.input.questions.entries()) {
    const row = value.distributions[index]!;
    if (row.questionId !== question.id || row.candidates.length !== question.choices.length
      || row.promptTokenCount > request.limits.maximumPromptTokens
      || new Set(row.candidates.map(candidate => candidate.tokenId)).size !== row.candidates.length) fail();
    const maximum = Math.max(...row.candidates.map(candidate => candidate.logit));
    const weights = row.candidates.map(candidate => Math.exp(candidate.logit - maximum));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let best = 0, expectedLevel = 0;
    for (const [candidateIndex, candidate] of row.candidates.entries()) {
      if (candidate.value !== question.choices[candidateIndex]!.value
        || candidate.code !== String.fromCharCode(65 + candidateIndex)
        || Math.abs(candidate.probability - weights[candidateIndex]! / total) > 1e-8) fail();
      if (candidate.logit > row.candidates[best]!.logit) best = candidateIndex;
      if (question.type === "integer_levels") expectedLevel += question.choices[candidateIndex]!.value * candidate.probability;
    }
    if (Math.abs(row.candidates.reduce((sum, candidate) => sum + candidate.probability, 0) - 1) > 1e-8
      || row.prediction !== question.choices[best]!.value
      || (question.type === "integer_levels" ? row.expectedLevel === null || Math.abs(row.expectedLevel - expectedLevel) > 1e-8 : row.expectedLevel !== null)) fail();
    promptWork += row.promptTokenCount;
  }
  if (value.forwardTokenWork < promptWork) fail();
  return value;
}
