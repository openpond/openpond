import {useEffect,useRef,useState} from "react";
import {z} from "zod";
import type {WorkspaceApi} from "../labs/workspace/workspace-api";
const Receipt=z.object({replay:z.boolean(),state:z.literal("acknowledged")}).strict();
type Intent={id:string;receiptId:string;sessionId:string;action:"message"|"seal";text?:string};
export function ClaudeProcessControls({api,executionId,receiptId,sessionId,active,onChanged}:{api:WorkspaceApi;executionId:string;receiptId:string;sessionId:string;active:boolean;onChanged:()=>void}){
 const [text,setText]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[held,setHeld]=useState(false);
 const pending=useRef<Intent|null>(null),current=useRef("");
 const key=`${api.key}:${executionId}:${receiptId}:${sessionId}`;
 useEffect(()=>{current.current=key;pending.current=null;setText("");setBusy(false);setError(null);setHeld(false);return()=>{current.current="disposed";};},[api,key]);
 async function send(action:"message"|"seal"){
  const scope=key;if(current.current!==scope||busy)return;setBusy(true);setError(null);
  try{
   const intent=pending.current??{id:executionId,receiptId,sessionId,action,...(action==="message"?{text}:{})};pending.current=intent;setHeld(true);
   // The authenticated operation owner retains this exact intent before process I/O.
   // Reopening/retrying the same intent recovers its original operation identity.
   const operation=await api.localOperation("claudeControl",intent);if(current.current!==scope)return;
   Receipt.parse(await api.local("claudeControl",{...intent,operationId:operation.id}));if(current.current!==scope)return;
   await operation.acknowledge();if(current.current!==scope)return;
   pending.current=null;setHeld(false);setText("");onChanged();
  }catch(error){if(current.current===scope)setError(error instanceof Error?error.message:"Live process control failed.");}
  finally{if(current.current===scope)setBusy(false);}
 }
 return <section><h3>Live process intervention</h3><p>Messages are separate retained interventions. They do not change the original task input. Reopening this case reads the same process stream.</p><label>Message<textarea value={text} maxLength={262144} disabled={busy||!active||held} onChange={event=>setText(event.target.value)}/></label>{error?<p role="alert">{error}</p>:null}<button type="button" disabled={busy||!active||!text.trim()||held} onClick={()=>void send("message")}>Send to this session</button><button type="button" disabled={busy||!active||held} onClick={()=>void send("seal")}>Seal after current turn</button>{held?<button type="button" disabled={busy} onClick={()=>void send(pending.current!.action)}>Read same receipt</button>:null}<p>An uncertain intervention stays held. Inspect its stream before taking another action. Cancel the Experiment to terminate its full process tree. A restarted execution owner retains partial evidence and does not relaunch the CLI automatically.</p></section>;
}
