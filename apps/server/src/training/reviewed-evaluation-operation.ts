import {contentHash} from "@openpond/harness";
import {z} from "zod";
import {AdvancedRefinerEvaluationCommandSchema,AdvancedRefinerEvaluationPrepareSchema,verifyAdvancedRefinerEvaluationPin} from "openpond-sdk/advanced-refiner-evaluations";
import {ExperimentEvaluationScheduleInputSchema,ExperimentEvaluationScheduleCommandSchema} from "openpond-sdk/experiment-evaluation-schedules";
const AdvancedIntent=AdvancedRefinerEvaluationPrepareSchema.omit({operation:true,operationId:true}).extend({localModelId:z.string().min(1),modelId:z.string().min(1)}).strict();
const ScheduleControlIntent=z.object({id:z.string().min(1),revision:z.number().int().nonnegative(),action:z.enum(["pause","cancel_active","retry_active"])}).strict();
export function validateReviewedEvaluationIntent(action:string,raw:unknown){
  if(action==="advanced-refiner-start")return AdvancedIntent.parse(raw);
  if(action!=="experiment-evaluation-schedule")throw new Error("This action does not retain reviewed payloads.");
  const control=ScheduleControlIntent.safeParse(raw);if(control.success)return control.data;
  const input=z.record(z.string(),z.unknown()).parse(raw),{operationId:_id,...body}=ExperimentEvaluationScheduleInputSchema.parse({...input,operationId:"reviewed-intent"});
  return body;
}
/** Only canonical public commands/refs enter the durable device journal. Private
 * source/holdout bytes and connection credentials are never command fields. */
export function validateReviewedEvaluationCommand(input:{action:string;id:string;actorId:string;teamId:string;projectId:string|null;intent:unknown;command:unknown}){
  if(input.action==="advanced-refiner-start"){
    const intent=AdvancedIntent.parse(input.intent);
    const command=AdvancedRefinerEvaluationCommandSchema.parse(input.command);if(command.operation!=="start")throw new Error("This retained action requires its reviewed advanced Start.");
    const request=command.request,pin=verifyAdvancedRefinerEvaluationPin(request.pin);
    if(pin.operationId!==input.id||pin.actorId!==input.actorId||pin.teamId!==input.teamId||pin.projectId!==input.projectId||request.modelId!==intent.localModelId||request.model.providerId!=="openpond"||request.model.modelId!==intent.modelId
      ||contentHash(pin.evidence)!==contentHash(intent.evidence)||pin.mode!==intent.mode||pin.adaptationSplit!==intent.adaptationSplit||contentHash(pin.refinerRelease)!==contentHash(intent.refinerRelease)
      ||pin.maximumCostUsd!==intent.maximumCostUsd||pin.maximumDurationMs!==intent.maximumDurationMs||pin.maximumModelSteps!==intent.maximumModelSteps||pin.profileRef.profileId!==request.profileId)
      throw new Error("The retained advanced command differs from its original reviewed authority or limits.");
    return command;
  }
  if(input.action!=="experiment-evaluation-schedule")throw new Error("This action cannot retain reviewed evaluation commands.");
  const command=ExperimentEvaluationScheduleCommandSchema.parse(input.command);
  if(command.operation==="publish"){
    const {operationId,...intent}=command.request;
    if(operationId!==input.id||command.request.teamId!==input.teamId||command.request.projectId!==input.projectId||contentHash(intent)!==contentHash(input.intent))throw new Error("The retained schedule command differs from its exact reviewed intent.");
  }else if(command.operation==="control"){
    const intent=ScheduleControlIntent.parse(input.intent);
    if(command.request.operationId!==input.id||command.request.teamId!==input.teamId||command.request.id!==intent.id||command.request.expectedRevision!==intent.revision||command.request.action!==intent.action)throw new Error("The retained schedule control changed its reviewed revision.");
  }else throw new Error("Only explicit schedule publication/control enters operation recovery.");
  return command;
}
