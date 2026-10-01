import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import { TrainingActivityAuthoritySchema, type ResolveTrainingActivityAuthority } from "./training-activity-authority.js";

/** Resolve a current authorized association before launch, never infer ownership
 * for historical jobs or copy an arbitrary selected Project into their payload. */
export function createTrainingActivityAuthorityResolver(deps:{
  identity:()=>Promise<{actorId:string;teamId:string}>;
  access:()=>Promise<{apiBaseUrl:string;token:string}>;
}):ResolveTrainingActivityAuthority {
  return async modelId=>{
    const identity=await deps.identity(),access=await deps.access();
    const client=new OpenPondTrainingProjectClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:identity.teamId});
    const matches=new Set<string>(); let cursor:string|undefined;
    const seen=new Set<string>();
    for(let pageNumber=0;;pageNumber++) {
      if(pageNumber>=100)throw new Error("Project associations exceeded the supported launch bound.");
      const page=await client.list(cursor?{cursor}:{});
      for(const project of page.projects)if(!project.archived&&project.content.resources.some(resource=>resource.kind==="training_configuration"&&resource.resourceId===modelId))matches.add(project.id);
      if(!page.nextCursor)break;
      if(seen.has(page.nextCursor))throw new Error("Project association pagination did not advance.");
      seen.add(page.nextCursor);cursor=page.nextCursor;
    }
    if(matches.size>1)throw new Error("This training configuration belongs to several Projects. Retain one explicit Project association before starting.");
    const current=await deps.identity();
    if(current.actorId!==identity.actorId||current.teamId!==identity.teamId)throw new Error("The active account changed before training admission.");
    return TrainingActivityAuthoritySchema.parse({schemaVersion:"openpond.trainingActivityAuthority.v1",...identity,projectId:[...matches][0]??null});
  };
}
