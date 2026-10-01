import type { Session,Turn } from "@openpond/contracts";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";

type Resolver=(session:Session,turn:Turn)=>Promise<typeof streamOpenPondHostedChatTurn|null>;
/** Restart never converts a retained Experiment session into ordinary chat
 * authority. Only its live immutable owner may supply model dispatch. */
export function experimentSessionStreamResolver(resolve?:Resolver):Resolver {
  return async(session,turn)=> {
    const stream=await resolve?.(session,turn)??null;
    if((session.metadata?.standaloneExperiment!==undefined||session.metadata?.localProfileExperiment!==undefined)&&!stream)
      throw new Error("This native Experiment session has no active durable model-dispatch owner.");
    return stream;
  };
}
