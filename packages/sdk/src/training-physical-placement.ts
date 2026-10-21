import { z } from "zod";

/** Placement authority only: a fresh learner never inherits the source Policy. */
export const TrainingPhysicalPlacementSchema = z.object({
  mode: z.literal("reuse_only"),
  physicalWorkerId: z.string().trim().min(1).max(191),
  providerPodId: z.string().trim().min(1).max(191),
  workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  baseProfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  gpuType: z.string().trim().min(1).max(200),
  sourceJobId: z.string().trim().min(1).max(191),
  sourceInputManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ownerTeamId: z.string().trim().min(1).max(191),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();

export type TrainingPhysicalPlacement = z.infer<typeof TrainingPhysicalPlacementSchema>;
