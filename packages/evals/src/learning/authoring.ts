import { z } from "zod";
import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { RewardBindingSourceSchema, RewardReleaseRefSchema } from "../rewards.js";
import { LearningRevisionRefSchema } from "./contracts.js";

/** Strings intentionally preserve incomplete JSON/code until explicit publication. */
export const RewardAuthoringFieldsSchema = z.object({
  name: z.string().max(500), description: z.string().max(10_000),
  kind: z.enum(["custom_verifier", "state", "content", "schema", "artifact", "runtime_event", "model_judge", "learned_model", "human"]),
  fields: z.string(), outputField: z.string(), expectedField: z.string(), expectedValue: z.string(),
  schema: z.string(), reference: z.string(), events: z.string(), code: z.string(), exportName: z.string(), timeout: z.string(),
  rubric: z.string(), providerId: z.string(), modelId: z.string(), modelRevision: z.string(), temperature: z.string(),
  reviewerRole: z.string(), learnedId: z.string(), learnedHash: z.string(), inputContract: z.string(), minimum: z.string(), maximum: z.string(),
}).strict();
export const TaskFormatAuthoringFieldsSchema = z.object({
  name: z.string().max(500), description: z.string().max(10_000), instructions: z.string().max(20_000),
  input: z.string(), output: z.string(), familyNamespace: z.string(),
  sources: z.array(RewardBindingSourceSchema).max(100), recipeRef: RewardReleaseRefSchema.optional(),
}).strict();
export const CombinedRewardAuthoringFieldsSchema = z.object({
  name: z.string().max(500), description: z.string().max(10_000), sources: z.array(RewardBindingSourceSchema).max(100),
}).strict();
export const AuthoringTargetKindSchema = z.enum(["definition", "reward", "binding"]);
const base = z.object({ id: ReleaseIdSchema, targetId: ReleaseIdSchema, baseRelease: LearningRevisionRefSchema.nullable(), editorVersion: z.literal("openpond.modelsEditor.v1") });
export const AuthoringDraftInputSchema = z.discriminatedUnion("targetKind", [
  base.extend({ targetKind: z.literal("definition"), fields: TaskFormatAuthoringFieldsSchema }).strict(),
  base.extend({ targetKind: z.literal("reward"), fields: RewardAuthoringFieldsSchema }).strict(),
  base.extend({ targetKind: z.literal("binding"), fields: CombinedRewardAuthoringFieldsSchema }).strict(),
]);
const history = {
  schemaVersion: z.literal("openpond.authoringDraft.v1"), revision: z.number().int().positive(),
  status: z.enum(["draft", "archived", "published"]), publishedRelease: LearningRevisionRefSchema.nullable(),
  createdAt: ReleaseTimestampSchema, updatedAt: ReleaseTimestampSchema,
};
export const AuthoringDraftContentSchema = z.discriminatedUnion("targetKind", [AuthoringDraftInputSchema.options[0].extend(history).strict(), AuthoringDraftInputSchema.options[1].extend(history).strict(), AuthoringDraftInputSchema.options[2].extend(history).strict()]);
export const AuthoringDraftSchema = z.discriminatedUnion("targetKind", [AuthoringDraftContentSchema.options[0].extend({ contentHash: ReleaseHashSchema }).strict(), AuthoringDraftContentSchema.options[1].extend({ contentHash: ReleaseHashSchema }).strict(), AuthoringDraftContentSchema.options[2].extend({ contentHash: ReleaseHashSchema }).strict()]);
export type AuthoringDraft = z.infer<typeof AuthoringDraftSchema>;
export type AuthoringDraftInput = z.infer<typeof AuthoringDraftInputSchema>;
export type AuthoringTargetKind = z.infer<typeof AuthoringTargetKindSchema>;
export type AuthoringDraftFor<K extends AuthoringTargetKind> = Extract<AuthoringDraft, { targetKind: K }>;

/** Exact draft and resulting release are finalized in the publication transaction. */
export const AuthoringDraftFinalizationSchema = z.object({ draft: LearningRevisionRefSchema, targetKind: AuthoringTargetKindSchema, release: LearningRevisionRefSchema }).strict();
