import type {WorkspaceToolRequest} from "@openpond/contracts";
import type {ModelToolDefinition} from "../openpond/model-tool-registry.js";
import type {TurnRunnerDependencies} from "../runtime/turns/ports.js";
import {workspaceToolResultToModelToolResult} from "../openpond/model-tool-result.js";

export const candidateAuthoringToolNames=new Set(["ask_user","get_profile","agent_inspect","agent_build","agent_validate","agent_eval","agent_run","agent_traces","agent_check","exec_command","view_image","list_files","read_files","search_files","write_file","write_files","edit_file","delete_file","workspace_status"]);
/** Ordinary file operations use the same admitted workspace executor, with no
 * browser, remote-resource, ownership, installation or publication surface. */
export function candidateFileToolDefinitions(executeWorkspaceTool:TurnRunnerDependencies["executeWorkspaceTool"]):ModelToolDefinition[] {
  const text={type:"string"},path={type:"string",minLength:1},definitions:[WorkspaceToolRequest["action"],Record<string,unknown>,string[]][]=[
    ["list_files",{},[]],["workspace_status",{},[]],["read_files",{paths:{type:"array",items:path,minItems:1,maxItems:30}},["paths"]],
    ["search_files",{query:{type:"string",minLength:1,maxLength:2000}},["query"]],
    ["write_file",{path,content:text},["path","content"]],["write_files",{files:{type:"object",additionalProperties:text,maxProperties:30}},["files"]],
    ["edit_file",{path,oldText:{type:"string",minLength:1},newText:text,replaceAll:{type:"boolean"}},["path","oldText","newText"]],
    ["delete_file",{path},["path"]]];
  return definitions.map(([name,properties,required])=>({name,description:`${name.replaceAll("_"," ")} in the isolated selected candidate component. Paths are relative to its public source tree.`,
    parameters:{type:"object",additionalProperties:false,properties,required},execute:async context=>{
      const result=await executeWorkspaceTool(context.session.id,{action:name,args:context.args,source:"chat_action"},{turnId:context.turnId,workspaceDiffBaseline:context.workspaceDiffBaseline});
      return workspaceToolResultToModelToolResult(context.callId,name,result);
    }}));
}
