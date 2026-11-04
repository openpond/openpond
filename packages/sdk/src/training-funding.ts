import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Amount = z.number().positive().max(1_000_000);
const Decimal = z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const Timestamp = z.iso.datetime();
export const TrainingFundingDraftRefSchema = z.object({
  id: Id, revision: z.number().int().positive(), contentHash: Hash, projectId: Id.nullable(),
}).strict();
export const TrainingFundingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingFundingRequest.v1"),
  teamId: Id, maximumSpendUsd: Amount, draft: TrainingFundingDraftRefSchema.nullable().default(null),
}).strict();
/** Advisory coverage of the whole cap. This read neither reserves funds nor permits dispatch. */
export const TrainingFundingSchema = z.object({
  schemaVersion: z.literal("openpond.trainingFunding.v1"), teamId: Id, actorId: Id,
  requestHash: Hash, maximumSpendUsd: Amount, draft: TrainingFundingDraftRefSchema.nullable(),
  state: z.enum(["covered", "insufficient_credit", "member_limit", "unavailable"]),
  canViewBalance: z.boolean(), canPurchase: z.boolean(),
  availableUsageUsd: Decimal.nullable(), prepaidCreditUsd: Decimal.nullable(),
  checkedAt: Timestamp, expiresAt: Timestamp,
}).strict().superRefine((value, context) => {
  if (!value.canViewBalance && (value.availableUsageUsd !== null || value.prepaidCreditUsd !== null))
    context.addIssue({ code: "custom", path: ["canViewBalance"], message: "Private balances cannot accompany a restricted funding read." });
  if (Date.parse(value.expiresAt) <= Date.parse(value.checkedAt))
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Funding observations must expire after their check." });
});
export const TrainingFundingHandoffRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingFundingHandoffRequest.v1"),
  teamId: Id, maximumSpendUsd: Amount.nullable(), draft: TrainingFundingDraftRefSchema,
}).strict();
export const TrainingFundingHandoffSchema = z.object({
  schemaVersion: z.literal("openpond.trainingFundingHandoff.v1"), teamId: Id, actorId: Id,
  requestHash: Hash, maximumSpendUsd: Amount.nullable(), draft: TrainingFundingDraftRefSchema,
  canPurchase: z.boolean(), billingUrl: z.string().url().nullable(), checkedAt: Timestamp, expiresAt: Timestamp,
}).strict().superRefine((value, context) => {
  if (Boolean(value.billingUrl) !== value.canPurchase)
    context.addIssue({ code: "custom", path: ["billingUrl"], message: "A purchase handoff requires current billing access." });
  if (value.billingUrl) {
    const url = new URL(value.billingUrl);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !/^\/entry\/[A-Za-z0-9_-]{40,4096}$/.test(url.pathname))
      context.addIssue({ code: "custom", path: ["billingUrl"], message: "Use a grantless hosted Billing entry URL." });
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.checkedAt))
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Funding handoffs must expire after creation." });
});
export type TrainingFundingRequest = z.input<typeof TrainingFundingRequestSchema>;
export type TrainingFunding = z.infer<typeof TrainingFundingSchema>;
export type TrainingFundingHandoffRequest = z.infer<typeof TrainingFundingHandoffRequestSchema>;
export type TrainingFundingHandoff = z.infer<typeof TrainingFundingHandoffSchema>;

export async function parseAndVerifyTrainingFunding(raw: unknown, input: TrainingFundingRequest, actorId?: string) {
  const request = TrainingFundingRequestSchema.parse(input), value = TrainingFundingSchema.parse(raw);
  if (value.teamId !== request.teamId || actorId && value.actorId !== actorId || value.maximumSpendUsd !== request.maximumSpendUsd || canonicalJson(value.draft) !== canonicalJson(request.draft) || value.requestHash !== await canonicalSha256(request) || Date.parse(value.expiresAt) <= Date.now())
    throw new OpenPondProtocolError("training_funding_scope_mismatch", "Funding returned another actor, workspace, draft or spending cap.");
  return value;
}
export async function parseAndVerifyTrainingFundingHandoff(raw: unknown, input: TrainingFundingHandoffRequest, actorId?: string) {
  const request = TrainingFundingHandoffRequestSchema.parse(input), value = TrainingFundingHandoffSchema.parse(raw);
  if (value.teamId !== request.teamId || actorId && value.actorId !== actorId || value.maximumSpendUsd !== request.maximumSpendUsd || canonicalJson(value.draft) !== canonicalJson(request.draft) || value.requestHash !== await canonicalSha256(request) || Date.parse(value.expiresAt) <= Date.now())
    throw new OpenPondProtocolError("training_funding_handoff_scope_mismatch", "Billing returned another actor, workspace, draft or spending cap.");
  return value;
}
export function createTrainingFundingClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async funding(input: TrainingFundingRequest) {
      const parsed = TrainingFundingRequestSchema.parse(input);
      return parseAndVerifyTrainingFunding(await request("/v1/training/funding/preview", { method: "POST", body: canonicalJson(parsed) }), parsed);
    },
    async fundingHandoff(input: TrainingFundingHandoffRequest) {
      const parsed = TrainingFundingHandoffRequestSchema.parse(input);
      return parseAndVerifyTrainingFundingHandoff(await request("/v1/training/funding/handoff", { method: "POST", body: canonicalJson(parsed) }), parsed);
    },
  };
}
