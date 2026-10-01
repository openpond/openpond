import {useEffect,useState} from "react";
import {HumanGraderChoicesSchema,type ReviewReleaseSchema} from "@openpond/evals/human-review";
import type {z} from "zod";
import {humanRequest,type HumanInboxContext} from "./api";
export function useHumanGraderChoices(context:HumanInboxContext|undefined,projectId:string|undefined,dataset:z.infer<typeof ReviewReleaseSchema>|undefined){
  const [choices,setChoices]=useState<z.infer<typeof HumanGraderChoicesSchema>>([]),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
  useEffect(()=>{const controller=new AbortController();setChoices([]);setError(null);if(!context||!projectId||!dataset)return;setLoading(true);void humanRequest(context,{endpoint:"graders",scope:context.scope,projectId,dataset},controller.signal).then(raw=>{if(!controller.signal.aborted)setChoices(HumanGraderChoicesSchema.parse(raw));}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[context?.scope,context?.actorId,context?.location,context?.connection,projectId,dataset?.id,dataset?.revision,dataset?.contentHash]);
  return{choices,error,loading};
}
