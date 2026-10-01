import {z} from "zod";
export const EvaluationOperationRecoverySchema=z.object({
  id:z.uuid(),action:z.enum(["advanced-refiner-start","experiment-evaluation-schedule"]),
  intentHash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),
  reviewedIntent:z.unknown().nullable(),command:z.unknown().nullable(),
  phase:z.enum(["reviewed","dispatching"]).nullable(),recoveryReady:z.boolean(),
}).strict().superRefine((value,context)=> {
  if(value.recoveryReady!==(value.reviewedIntent!==null&&value.command!==null&&value.phase!==null))context.addIssue({code:"custom",message:"Only the actual retained intent and command admit automatic recovery."});
});
export type EvaluationOperationRecovery=z.infer<typeof EvaluationOperationRecoverySchema>;
export const EvaluationOperationRecoveryPageSchema=z.object({items:z.array(EvaluationOperationRecoverySchema).max(100),nextCursor:z.uuid().nullable()}).strict();
