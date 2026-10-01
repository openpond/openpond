import { compareExperiments, type verifyExperimentEvidence } from "@openpond/evals/experiments";
import type { ExperimentGraderPinSchema } from "openpond-sdk/experiments";
import type {z} from "zod";
/** Aggregate only sealed authorized evidence. Case bytes never enter the reply. */
export function experimentFeedbackSummary(input:{experimentId:string;executionManifestHash:string;total:number;graders:z.infer<typeof ExperimentGraderPinSchema>[];evidence:ReturnType<typeof verifyExperimentEvidence>}) {
  const metrics=compareExperiments(input.evidence,input.evidence).metrics;
  return {experimentId:input.experimentId,executionManifestHash:input.executionManifestHash,
    manifest:{id:input.evidence.manifest.id,contentHash:input.evidence.manifest.contentHash},resultHash:input.evidence.result.contentHash,
    graders:input.graders.map(grader=> {
      const metric=metrics.find(item=>item.feedbackKey===grader.feedbackKey),complete=metric?.eligibleCount===input.total;
      return {id:grader.id,name:grader.name??null,feedbackKey:grader.feedbackKey,release:grader.release,
        status:complete&&metric?.baseline!==null?"available" as const:"unavailable" as const,
        mean:complete?metric?.baseline??null:null,count:metric?.eligibleCount??0,total:input.total};
    })};
}

/** Bound retained reads across collection rows; failed reads are never cached. */
export function createFeedbackSummaryReader() {
  const cache=new Map<string,{expires:number;value:ReturnType<typeof experimentFeedbackSummary>}>();
  const pending=new Map<string,Promise<ReturnType<typeof experimentFeedbackSummary>>>();
  const waiting:Array<()=>void>=[];let active=0;
  return async(key:string,read:()=>Promise<ReturnType<typeof experimentFeedbackSummary>>)=> {
    const retained=cache.get(key);if(retained&&retained.expires>Date.now())return retained.value;
    const prior=pending.get(key);if(prior)return prior;
    const next=(async()=> {
      if(active>=4)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
      try {const value=await read();cache.delete(key);cache.set(key,{value,expires:Date.now()+60_000});
        while(cache.size>100)cache.delete(cache.keys().next().value!);return value;
      } finally {const resume=waiting.shift();if(resume)resume();else active--;pending.delete(key);}
    })();pending.set(key,next);return next;
  };
}
