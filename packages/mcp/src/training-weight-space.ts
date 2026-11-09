import { z } from "zod";
import { WeightSpacePrepareSchema, WeightSpaceCommandSchema, WeightSpaceResultSaveRequestSchema,
  WeightSpaceModelServingQuerySchema, WeightSpaceModelServingControlRequestSchema, WeightSpaceCommandListQuerySchema, WeightSpaceExecutionListQuerySchema, ModelModificationCapabilitiesQuerySchema,
  ManagedModificationStartSchema, ManagedModificationCancelSchema } from "openpond-sdk/training";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, verifyPrincipal, withoutWorkspace } from "./common.js";
export function addWeightSpaceTools(add:AddTool,c:Clients,context:OpenPondMcpContext){
  const {teamId}=context,query=ModelModificationCapabilitiesQuerySchema.omit({teamId:true});
  const principal=<T extends {teamId:string;ownerUserId?:string;actorId?:string}>(value:T)=>verifyPrincipal(value,context);
  const receipt=<T extends {execution:{teamId:string;ownerUserId:string}}>(value:T)=>{principal(value.execution);return value;};
  add("training_weight_space_capabilities","Discover exact remote editing runtime support. This starts no compute.",query,"read",
    async v=>principal(await c.training.weightSpaceCapability({...v,teamId})));
  add("training_weight_space_prepare","Prepare a local-agent/remote-weight session with exact source, objective, development panels and approved bounds. Starts no compute.",
    withoutWorkspace(WeightSpacePrepareSchema).extend({query}),"write",async v=>receipt(await c.training.prepareWeightSpaceSession({...v,teamId,query:{...v.query,teamId}})));
  add("training_weight_space_get","Read the exact session, current candidate, usage and retained final result.",ById,"read",
    async v=>principal(await c.training.getWeightSpaceSession(teamId,v.id)));
  add("training_weight_space_list","List this user's weight-space sessions in the authenticated workspace.",WeightSpaceExecutionListQuerySchema,"read",
    async v=>principal(await c.training.listWeightSpaceSessions(teamId,v)));
  add("training_weight_space_history","Read retained hypotheses, programs, evaluations and candidate receipts in revision order.",z.object({id:ById.shape.id,query:WeightSpaceCommandListQuerySchema.optional()}).strict(),"read",
    async v=>principal(await c.training.listWeightSpaceCommands(teamId,v.id,v.query)));
  add("training_weight_space_start","Start this exact reviewed billed editing session. Retain its plan, price and spending approval.",
    withoutWorkspace(ManagedModificationStartSchema).omit({action:true}),"execute",async v=>receipt(await c.training.startWeightSpaceSession({...v,teamId,action:"start"})),{scopes:["app:read","app:execute"],idempotent:true});
  add("training_weight_space_command","Inspect tensor metadata/slices, execute a bounded tensor program, evaluate declared development/preservation prompts, select or finalize an exact candidate. Reuse the same operation ID after uncertainty; never replay under a fresh ID.",
    z.object({command:WeightSpaceCommandSchema}),"execute",async v=>{if(v.command.teamId!==teamId)throw new Error("Use the authenticated workspace.");return principal(await c.training.commandWeightSpaceSession(v.command));},{scopes:["app:read","app:execute"],idempotent:true,destructive:false});
  add("training_weight_space_command_result","Recover the original command receipt without repeating its work.",z.object({sessionId:z.string().min(1).max(240),operationId:z.string().min(1).max(240)}).strict(),"read",
    async v=>principal(await c.training.getWeightSpaceCommand(teamId,v.sessionId,v.operationId)));
  add("training_weight_space_cancel","Cancel this exact editing session through its existing compute owner.",
    withoutWorkspace(ManagedModificationCancelSchema).omit({action:true}),"cancel",async v=>receipt(await c.training.cancelWeightSpaceSession({...v,teamId,action:"cancel"})),
    {scopes:["app:read","app:cancel"],idempotent:true});
  add("training_weight_space_save_model","Save the exact completed patch as a Model version. Saving never activates serving.",withoutWorkspace(WeightSpaceResultSaveRequestSchema),"write",
    async v=>principal(await c.training.saveWeightSpaceResultModel({...v,teamId})));
  add("training_weight_space_model_serving","Inspect separately qualified serving for the exact saved weight-space Model version.",withoutWorkspace(WeightSpaceModelServingQuerySchema).extend({modelProjectId:ById.shape.id}),"read",
    async v=>principal(await c.training.weightSpaceModelServing(v.modelProjectId,{teamId,versionHash:v.versionHash})));
  add("training_weight_space_model_serving_control","Activate or stop separately approved exact-version serving. Saving a patch never authorizes this operation.",withoutWorkspace(WeightSpaceModelServingControlRequestSchema).extend({modelProjectId:ById.shape.id}),"execute",
    async v=>{const {modelProjectId,...request}=v;return principal(await c.training.controlWeightSpaceModelServing(modelProjectId,{...request,teamId}));},{scopes:["app:read","app:execute"],idempotent:true});

}
