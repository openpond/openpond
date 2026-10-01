import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ExperimentAttemptGradeSchema } from "openpond-sdk/experiments";
import { LocalExperimentNativeEvidenceSchema,LocalExperimentProfileEvidenceSchema } from "@openpond/contracts";
import { LocalExperimentError } from "./local-experiment-contract.js";

export function localRetainedAttempt(value:unknown) {
  const result=z.object({taskId:z.string(),status:z.string(),output:z.string().nullable(),error:z.string().nullable(),
    messages:z.array(z.unknown()).max(4002),environmentCleanupComplete:z.boolean(),contentHash:z.string(),
    native:LocalExperimentNativeEvidenceSchema.optional(),profileNative:LocalExperimentProfileEvidenceSchema.optional()}).passthrough().parse(value);
  const {contentHash:hash,...body}=result;
  if(contentHash(body)!==hash)throw new LocalExperimentError("local_case_integrity_failed","Retained case output differs from its sealed receipt.");
  if(!result.environmentCleanupComplete)throw new LocalExperimentError("local_case_cleanup_unconfirmed","The case executor has not confirmed environment cleanup.");
  return result;
}
export function localRetainedCase(value:unknown) {
  const parsed=z.object({attempt:z.unknown(),grade:ExperimentAttemptGradeSchema.nullable(),contentHash:z.string()}).strict().parse(value);
  const {contentHash:hash,...content}=parsed;
  if(hash!==contentHash(content))throw new LocalExperimentError("local_case_result_integrity_failed","Retained local case evidence changed.");
  return {...parsed,attempt:localRetainedAttempt(parsed.attempt)};
}
export function sealLocalRetainedCase(attempt:unknown,grade: z.infer<typeof ExperimentAttemptGradeSchema>|null) {
  localRetainedAttempt(attempt);
  const content={attempt,grade};return {...content,contentHash:contentHash(content)};
}

/** Private projection matches the released tool-grader environment contract.
 * Only a verified owner receipt is accepted; this context never reaches policy
 * messages, renderer results or the public case trace. */
export function localEvaluatorContext(attempt:ReturnType<typeof localRetainedAttempt>) {
  if(!attempt.snapshot)return null;
  const snapshot=z.object({definition:z.record(z.string(),z.unknown()),initialStateHash:z.string(),finalStateHash:z.string(),
    state:z.record(z.string(),z.unknown()),events:z.array(z.unknown())}).passthrough().parse(attempt.snapshot);
  return {environment:{status:attempt.status,collected:attempt.collected===true,definition:snapshot.definition,
    initialStateHash:snapshot.initialStateHash,finalStateHash:snapshot.finalStateHash,finalState:snapshot.state,events:snapshot.events}};
}
