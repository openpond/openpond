import { z } from "zod";

const Node = z
  .object({
    label: z.string(),
    state: z.enum(["done", "active", "pending", "missing", "failed"]),
    status: z.string(),
    detail: z.string().optional(),
    error: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    inLoop: z.boolean().optional(),
  })
  .strict();
/** Read-only projection of execution evidence for the console flow diagram. */
export const RunStageEvidenceSchema = z
  .object({
    jobId: z.string(),
    teamId: z.string(),
    modelProjectId: z.string(),
    state: z.string(),
    policyVersion: z.number().int().nonnegative(),
    groupsCompleted: z.number().int().nonnegative(),
    groupsTarget: z.number().int().nonnegative(),
    live: z.boolean(),
    nodes: z.array(Node).max(10),
    inference: Node.nullable(),
    groups: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            state: z.string(),
            meanReward: z.number().nullable(),
            plannedSlots: z.number().int().nonnegative(),
            attempts: z
              .array(
                z
                  .object({
                    id: z.string(),
                    slot: z.number().int().nonnegative(),
                    attempt: z.number().int().positive(),
                    state: z.string(),
                    reward: z.number().nullable(),
                  })
                  .strict(),
              )
              .max(1000),
          })
          .strict(),
      )
      .max(50),
    groupCount: z.number().int().nonnegative(),
    logs: z
      .array(
        z
          .object({
            id: z.string(),
            at: z.string(),
            source: z.string(),
            message: z.string(),
            level: z.string(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type RunStageEvidence = z.infer<typeof RunStageEvidenceSchema>;
