import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseTimestampSchema,
  canonicalJson,
  contentHash,
} from "./common.js";

export const RefinerProposalRouteSchema = z.enum(["memory", "prompt", "skill", "agent"]);
export const RefinerExternalRouteSchema = z.enum(["runtime", "product", "taskset", "training"]);

export const RefinerReviewInstructionSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  text: z.string().trim().min(1).max(10_000),
}).strict();

export const RefinerReviewProfileSchema = z.object({
  schemaVersion: z.literal("openpond.refinerReviewProfile.v1"),
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  version: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(10_000),
  instructions: z.array(RefinerReviewInstructionSchema).max(100),
  allowedProposalRoutes: z.array(RefinerProposalRouteSchema).max(4),
  allowedExternalRoutes: z.array(RefinerExternalRouteSchema).max(4),
}).strict().superRefine((profile, context) => {
  const instructionIds = profile.instructions.map((instruction) => instruction.id);
  if (new Set(instructionIds).size !== instructionIds.length) {
    context.addIssue({ code: "custom", message: "instruction IDs must be unique", path: ["instructions"] });
  }
  if (new Set(profile.allowedProposalRoutes).size !== profile.allowedProposalRoutes.length) {
    context.addIssue({ code: "custom", message: "proposal routes must be unique", path: ["allowedProposalRoutes"] });
  }
  if (new Set(profile.allowedExternalRoutes).size !== profile.allowedExternalRoutes.length) {
    context.addIssue({ code: "custom", message: "external routes must be unique", path: ["allowedExternalRoutes"] });
  }
});

export type RefinerReviewProfile = z.infer<typeof RefinerReviewProfileSchema>;

export const DEFAULT_REFINER_REVIEW_PROFILE: RefinerReviewProfile = {
  schemaVersion: "openpond.refinerReviewProfile.v1",
  id: "openpond.default",
  version: "1",
  name: "OpenPond default review",
  objective: "Find the smallest reusable change that improves future work without learning task-specific facts.",
  instructions: [],
  allowedProposalRoutes: ["memory", "prompt", "skill", "agent"],
  allowedExternalRoutes: ["runtime", "product", "taskset", "training"],
};

export const RefinerReleaseSchema = z.object({
  schemaVersion: z.literal("openpond.refinerRelease.v1"),
  id: z.string().trim().min(1).max(240),
  coreVersion: z.string().trim().min(1).max(120),
  coreHash: ReleaseHashSchema,
  profile: RefinerReviewProfileSchema,
  profileHash: ReleaseHashSchema,
  composedPromptHash: ReleaseHashSchema,
  createdAt: ReleaseTimestampSchema,
  contentHash: ReleaseHashSchema,
}).strict();

export type RefinerRelease = z.infer<typeof RefinerReleaseSchema>;

export const RefinerBindingSchema = z.object({
  schemaVersion: z.literal("openpond.refinerBinding.v1"),
  channel: z.literal("active"),
  revision: z.number().int().nonnegative(),
  release: ImmutableReleaseRefSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict();

export type RefinerBinding = z.infer<typeof RefinerBindingSchema>;

export const RefinerTransitionReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.refinerTransitionReceipt.v1"),
  id: z.string().trim().min(1).max(240),
  operation: z.enum(["initialize", "update", "activate", "rollback"]),
  bindingChanged: z.boolean(),
  previousRelease: ImmutableReleaseRefSchema.nullable(),
  nextRelease: ImmutableReleaseRefSchema,
  actor: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(10_000),
  authoringSkillHash: ReleaseHashSchema.nullable(),
  validation: z.object({ valid: z.boolean(), messages: z.array(z.string().max(2_000)).max(100) }).strict(),
  createdAt: ReleaseTimestampSchema,
  contentHash: ReleaseHashSchema,
}).strict();

export type RefinerTransitionReceipt = z.infer<typeof RefinerTransitionReceiptSchema>;

export function defineReviewProfile(profile: RefinerReviewProfile): RefinerReviewProfile {
  return RefinerReviewProfileSchema.parse(profile);
}

export function createRefinerRelease(input: {
  profile: RefinerReviewProfile;
  coreVersion: string;
  corePrompt: string;
  createdAt?: string;
}): RefinerRelease {
  const profile = RefinerReviewProfileSchema.parse(input.profile);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const coreHash = contentHash({ coreVersion: input.coreVersion, corePrompt: input.corePrompt });
  const profileHash = contentHash(profile);
  const composedPromptHash = contentHash({ coreHash, profile });
  const releaseWithoutHash = {
    schemaVersion: "openpond.refinerRelease.v1" as const,
    id: `refiner-${composedPromptHash.slice(0, 24)}`,
    coreVersion: input.coreVersion,
    coreHash,
    profile,
    profileHash,
    composedPromptHash,
    createdAt,
  };
  return RefinerReleaseSchema.parse({
    ...releaseWithoutHash,
    contentHash: contentHash(releaseWithoutHash),
  });
}

export function refinerProfilePrompt(profile: RefinerReviewProfile): string {
  const parsed = RefinerReviewProfileSchema.parse(profile);
  return [
    `Review profile: ${parsed.name} (${parsed.id}@${parsed.version})`,
    `Objective: ${parsed.objective}`,
    `Allowed Harness proposal routes: ${parsed.allowedProposalRoutes.join(", ")}.`,
    `Allowed external routes: ${parsed.allowedExternalRoutes.join(", ")}.`,
    ...parsed.instructions.map((instruction) => `[${instruction.id}] ${instruction.text}`),
  ].join("\n");
}

export function serializeReviewProfile(profile: RefinerReviewProfile): string {
  return canonicalJson(RefinerReviewProfileSchema.parse(profile));
}
