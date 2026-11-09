import { WeightSpaceModelServingControlCommandSchema, WeightSpaceModelServingQuerySchema } from "openpond-sdk/training";
import { z } from "zod";
import { WeightSpacePrepareSchema, WeightSpaceCommandSchema, WeightSpaceExecutionListQuerySchema,
  WeightSpaceCommandListQuerySchema, WeightSpaceResultSaveRequestSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema,
  ModelModificationCapabilitiesQuerySchema, type createTrainingClient } from "openpond-sdk/training";
import { optionString, parseBooleanOption, parseIntegerOption } from "./common/options";
type Options=Record<string,string|boolean>;
export const weightSpaceHostedActions=new Set(["hosted-weight-space-capability","hosted-prepare-weight-space",
  "hosted-start-weight-space","hosted-cancel-weight-space","hosted-weight-space-session","hosted-weight-space-sessions",
  "hosted-weight-space-serving","hosted-control-weight-space-serving", "hosted-weight-space-history", "hosted-weight-space-command","hosted-weight-space-command-result","hosted-save-weight-space-model"]);
/** One canonical SDK; never downloads a checkpoint or starts another agent. */
export async function runHostedWeightSpaceCommand(input:{action:string;target?:string;teamId:string;options:Options;
  client:ReturnType<typeof createTrainingClient>;readInput:()=>Promise<unknown>}):Promise<unknown>{
  const {action,target,teamId,options,client,readInput}=input;
  if(action==="hosted-weight-space-session"){
    if(!target)throw new Error("Supply the original session ID.");return client.getWeightSpaceSession(teamId,target);
  }
  if(action==="hosted-weight-space-history"){
    if(!target)throw new Error("Supply the original session ID.");
    const query=WeightSpaceCommandListQuerySchema.parse({afterRevision:parseIntegerOption(options.afterRevision,"--after-revision"),limit:parseIntegerOption(options.limit,"--limit")});
    return client.listWeightSpaceCommands(teamId,target,query);
  }
  if(action==="hosted-weight-space-command-result"){
    const operationId=optionString(options,"operationId");if(!target||!operationId)throw new Error("Supply the session and original --operation-id.");
    return client.getWeightSpaceCommand(teamId,target,operationId);
  }
  if(action==="hosted-weight-space-sessions"){
    if(target)throw new Error("List sessions using filters.");
    const query=WeightSpaceExecutionListQuerySchema.parse(Object.fromEntries(Object.entries({id:optionString(options,"id")||undefined,
      projectId:optionString(options,"projectId")||undefined,phase:optionString(options,"phase")||undefined,
      cursor:optionString(options,"cursor")||undefined,limit:parseIntegerOption(options.limit,"--limit")}).filter(([,v])=>v!==undefined)));
    return client.listWeightSpaceSessions(teamId,query);
  }
  if(action==="hosted-weight-space-serving"){
    const value=z.object({modelProjectId:z.string().min(1),...WeightSpaceModelServingQuerySchema.shape}).strict().parse(await readInput());
    if(value.teamId!==teamId)throw new Error("Use the authenticated workspace.");
    return client.weightSpaceModelServing(value.modelProjectId,{teamId,versionHash:value.versionHash});
  }
  if(action==="hosted-control-weight-space-serving"){
    const value=WeightSpaceModelServingControlCommandSchema.parse(await readInput());
    if(value.request.teamId!==teamId)throw new Error("Use the authenticated workspace.");
    if(value.request.action==="activate"&&!parseBooleanOption(options.yes))throw new Error("Activating billed serving capacity requires --yes.");
    return client.controlWeightSpaceModelServing(value.modelProjectId,value.request);
  }
  const raw=await readInput();
  const schema=action==="hosted-weight-space-capability"?ModelModificationCapabilitiesQuerySchema
    :action==="hosted-prepare-weight-space"?WeightSpacePrepareSchema:action==="hosted-start-weight-space"?ManagedModificationStartSchema
    :action==="hosted-cancel-weight-space"?ManagedModificationCancelSchema:action==="hosted-save-weight-space-model"?WeightSpaceResultSaveRequestSchema:WeightSpaceCommandSchema;
  const value=schema.parse(raw);if(value.teamId!==teamId)throw new Error("Use the authenticated workspace.");
  if(action==="hosted-weight-space-capability")return client.weightSpaceCapability(ModelModificationCapabilitiesQuerySchema.parse(value));
  if(action==="hosted-prepare-weight-space")return client.prepareWeightSpaceSession(WeightSpacePrepareSchema.parse(value));
  if(action==="hosted-start-weight-space"){
    if(!parseBooleanOption(options.yes))throw new Error("Starting a billed editing session requires --yes.");
    return client.startWeightSpaceSession(ManagedModificationStartSchema.parse(value));
  }
  if(action==="hosted-cancel-weight-space")return client.cancelWeightSpaceSession(ManagedModificationCancelSchema.parse(value));
  if(action==="hosted-save-weight-space-model")return client.saveWeightSpaceResultModel(WeightSpaceResultSaveRequestSchema.parse(value));
  if(action==="hosted-weight-space-command")return client.commandWeightSpaceSession(WeightSpaceCommandSchema.parse(value));
  throw new Error("Unsupported weight-space command.");
}
