import { z } from "zod";
import { ImmutableReleaseRefSchema } from "@openpond/harness";
import {
  RefinerBindingSchema,
  RefinerReleaseSchema,
  RefinerReviewProfileSchema,
  RefinerTransitionReceiptSchema,
} from "@openpond/harness/refiner";

export const RefinerHistoryPayloadSchema = z.object({
  rootPath: z.string(),
  sourcePath: z.string(),
  binding: RefinerBindingSchema,
  currentRelease: RefinerReleaseSchema,
  releases: z.array(RefinerReleaseSchema),
  transitions: z.array(RefinerTransitionReceiptSchema),
}).strict();

export const UpdateRefinerProfileRequestSchema = z.object({
  profile: RefinerReviewProfileSchema,
  activate: z.boolean().default(true),
  reason: z.string().trim().min(1).max(10_000),
  actor: z.string().trim().min(1).max(240).default("local-user"),
  authoringSkillHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict();

export const ActivateRefinerReleaseRequestSchema = z.object({
  release: ImmutableReleaseRefSchema,
  reason: z.string().trim().min(1).max(10_000),
  actor: z.string().trim().min(1).max(240).default("local-user"),
}).strict();

export type RefinerHistoryPayload = z.infer<typeof RefinerHistoryPayloadSchema>;
export type UpdateRefinerProfileRequest = z.infer<typeof UpdateRefinerProfileRequestSchema>;
export type ActivateRefinerReleaseRequest = z.infer<typeof ActivateRefinerReleaseRequestSchema>;
export type { RefinerBinding, RefinerRelease, RefinerReviewProfile, RefinerTransitionReceipt } from "@openpond/harness/refiner";
