import {useEffect,useRef,useState} from "react";
import {z} from "zod";
import {ReviewReleaseSchema,type HumanReviewView} from "@openpond/evals/human-review";
import {humanRequest,humanApi,type HumanInboxContext} from "./api";
import {HumanResultControls} from "./HumanResultControls";
export function LocalPublishedHumanResults({context,executionId,onOpenReview}:{context:HumanInboxContext;executionId:string;onOpenReview:(record:HumanReviewView)=>void}){
 const [refs,setRefs]=useState<z.infer<typeof ReviewReleaseSchema>[]>([]),[error,setError]=useState<string|null>(null),[refresh,setRefresh]=useState(0),[revoking,setRevoking]=useState<string|null>(null);
 const current=useRef(""),generation=useRef(0);
 const key=`${context.scope}:${context.actorId}:${context.location}:${executionId}`;
 useEffect(()=>{
  generation.current++;current.current=key;setRefs([]);setError(null);setRevoking(null);
  return()=>{generation.current++;current.current="disposed";};
 },[key,context.connection]);
 useEffect(()=>{
  const controller=new AbortController();
  if(context.location!=="local")return()=>controller.abort();
  void humanRequest(context,{endpoint:"local_publications",scope:context.scope,executionId},controller.signal)
   .then(raw=>{if(!controller.signal.aborted&&current.current===key){setRefs(z.array(ReviewReleaseSchema).max(1000).parse(raw));setError(null);}})
   .catch(error=>{if(!controller.signal.aborted&&current.current===key)setError(error.message);});
  return()=>controller.abort();
 },[key,context.connection,refresh]);
 useEffect(()=>{const changed=()=>setRefresh(n=>n+1);window.addEventListener("human-review-changed",changed);return()=>window.removeEventListener("human-review-changed",changed);},[]);

 const hosted={...context,location:"hosted" as const};
 async function revoke(ref:z.infer<typeof ReviewReleaseSchema>){const scope=key,epoch=generation.current;if(current.current!==scope)return;setRevoking(ref.id);setError(null);try{z.object({revoked:z.literal(true)}).strict().parse(await humanRequest(context,{endpoint:"revoke_local",scope:context.scope,publication:ref}));if(current.current!==scope||generation.current!==epoch)return;setRefs(old=>old.filter(value=>value.id!==ref.id));window.dispatchEvent(new Event("human-review-changed"));}catch(error){if(current.current===scope&&generation.current===epoch)setError(error instanceof Error?error.message:"Publication revocation failed.");}finally{if(current.current===scope&&generation.current===epoch)setRevoking(null);}}
 if(!refs.length&&!error)return null;
 return <section><h3>Published team evidence</h3><p>Owner-attested local evidence preserves the original sealed receipt and the published policy-facing cutoff. Team review does not control the original local process.</p>{error?<p role="alert">{error}</p>:null}{refs.map(ref=><p key={ref.id}><span>{ref.id}</span> <button type="button" disabled={Boolean(revoking)} onClick={()=>void revoke(ref)}>Revoke this publication</button></p>)}{refs.length?<HumanResultControls context={hosted} executionId={executionId} onOpenReview={id=>{const scope=key,epoch=generation.current;void humanApi.get(hosted,id).then(record=>{if(current.current===scope&&generation.current===epoch)onOpenReview(record);}).catch(error=>{if(current.current===scope&&generation.current===epoch)setError(error.message);});}}/>:null}</section>;
}
