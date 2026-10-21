import { z } from "zod";

const Diagnostic = z.object({
  label: z.string().max(200), value: z.string().max(12000),
  severity: z.enum(["info", "warning", "error"]).default("info"),
}).strict();

export const RunFeedbackTargetSchema = z.object({
  kind: z.enum(["trajectory", "evaluation"]), id: z.string().min(1).max(240), taskId: z.string().min(1).max(512).optional(),
}).strict().refine(value => value.kind === "evaluation" ? Boolean(value.taskId) : value.taskId === undefined, { message: "Evaluation feedback requires a task ID; trajectory feedback uses its receipt ID only." });
const FeedbackOutcome = z.object({ status: z.string(), score: z.number().nullable(), passed: z.boolean().nullable() }).strict();
export const RunGraderFeedbackSchema = z.object({
  jobId: z.string(), kind: z.enum(["trajectory", "evaluation"]), id: z.string(), taskId: z.string().optional(), compositionSha256: z.string(),
  training: FeedbackOutcome, evaluation: FeedbackOutcome,
  graders: z.array(z.object({ graderId: z.string(), role: z.enum(["training", "evaluation"]), status: z.string(), rawScore: z.number().nullable(), normalizedScore: z.number().nullable(), passed: z.boolean().nullable(), message: z.string().nullable(), failureClass: z.string().nullable(), feedback: z.array(z.string().max(32768)).max(8) }).strict()).max(32),
}).strict();
export type RunFeedbackTarget = z.infer<typeof RunFeedbackTargetSchema>;
export type RunGraderFeedback = z.infer<typeof RunGraderFeedbackSchema>;

const ReplayGroup = z.object({ sourceJobId: z.string(), checkpointId: z.string(), checkpointJobId: z.string(), groupId: z.string(), groupIndex: z.number().int().nonnegative(), optimizerDisposition: z.enum(["applied", "skipped_no_signal"]), inputPolicyVersion: z.number().int().nonnegative(), outputPolicyVersion: z.number().int().nonnegative().optional() }).strict();
const Node = z
  .object({
    label: z.string(),
    state: z.enum(["done", "active", "pending", "missing", "failed"]),
    status: z.string(),
    detail: z.string().optional(),
    diagnostics: z.array(Diagnostic).max(100).optional(),
    feedback: z.array(RunFeedbackTargetSchema).max(100).optional(),
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
    continuation: z.object({
      sourceJobId: z.string(), artifactId: z.string(), checkpointId: z.string(),
      optimizerMode: z.enum(["continue", "reset"]), materialized: z.boolean(),
      parentRank: z.number().int().positive().optional(),
      trainableRank: z.number().int().positive().optional(),
    }).strict().optional(),
    recovery: z.object({
      sourceJobId: z.string(), checkpointId: z.string(), checkpointJobId: z.string().optional(),
      policyVersion: z.number().int().positive(), completedGroups: z.number().int().positive(),
      optimizerStateRestored: z.boolean(),
      optimizerUpdatesApplied: z.number().int().nonnegative().optional(),
      replayGroups: z.array(ReplayGroup).max(128).optional(), replayCompleted: z.boolean().optional(), undurablePolicyVersion: z.number().int().positive().optional(),
    }).strict().optional(),
    nodes: z.array(Node).max(10),
    inference: Node.nullable(),
    groups: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            optimizerDisposition: z.enum(["applied", "skipped_no_signal"]).optional(),
            replay: ReplayGroup.optional(),
            inherited: z.object({ sourceJobId: z.string(), checkpointId: z.string(), checkpointJobId: z.string(), optimizerDisposition: z.enum(["applied", "skipped_no_signal"]), inputPolicyVersion: z.number().int().nonnegative(), outputPolicyVersion: z.number().int().nonnegative().optional() }).strict().optional(),
            nodes: z.array(Node).max(5).optional(),
            state: z.string(),
            meanReward: z.number().nullable(),
            plannedSlots: z.number().int().nonnegative(),
            diagnostics: z.array(Diagnostic).max(100).optional(),
            attempts: z
              .array(
                z
                  .object({
                    id: z.string(),
                    slot: z.number().int().nonnegative(),
                    attempt: z.number().int().positive(),
                    state: z.string(),
                    reward: z.number().nullable(),
                    diagnostics: z.array(Diagnostic).max(100).optional(),
                    feedback: z.array(RunFeedbackTargetSchema).max(100).optional(),
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
