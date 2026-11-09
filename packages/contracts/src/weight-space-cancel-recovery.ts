import { z } from "zod";
import { WeightSpaceExecutionMetadataSchema } from "openpond-sdk/training";
import { ActivationExperimentAccountSchema } from "./activation-experiment-recovery.js";
export const WeightSpaceCancelIntentSchema=z.object({account:ActivationExperimentAccountSchema,execution:WeightSpaceExecutionMetadataSchema}).strict()
  .superRefine(({account,execution},ctx)=>{
    if(account.teamId!==execution.teamId||account.actorId!==execution.ownerUserId||["completed","cancelled","failed"].includes(execution.phase))
      ctx.addIssue({code:"custom",message:"Retain the exact active editing session and its original account."});
  });
export type WeightSpaceCancelIntent=z.infer<typeof WeightSpaceCancelIntentSchema>;
