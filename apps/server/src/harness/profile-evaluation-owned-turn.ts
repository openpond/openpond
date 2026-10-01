import type { Turn } from "@openpond/contracts";

/** Cancellation is a settlement boundary. The caller retains dispatch
 * authority until both the interrupted native turn and send operation settle. */
export async function awaitProfileEvaluationTurn(input: {
  send(): Promise<Turn>;
  interrupt?(reason:string): Promise<Turn>;
  signal?:AbortSignal;
  timeoutMs:number;
  onInterrupt?:(kind:"cancelled"|"timed_out")=>void;
}):Promise<Turn> {
  input.signal?.throwIfAborted();
  let interruption:Promise<Turn>|undefined;
  let reason:Error|undefined;
  let rejectCancellation:(error:Error)=>void=()=>{};
  const cancellation=new Promise<never>((_,reject)=>{rejectCancellation=reject;});
  const cancel=(message:string,kind:"cancelled"|"timed_out")=> {
    if(reason)return;
    reason=new Error(message);
    input.onInterrupt?.(kind);
    if(input.interrupt) {
      interruption=input.interrupt(message);
      void interruption.catch(()=>undefined);
    } else rejectCancellation(reason);
  };
  const aborted=()=>cancel("Profile evaluation run cancelled.","cancelled");
  const timeout=setTimeout(()=>cancel(`Profile evaluation case exceeded its ${input.timeoutMs}ms timeout.`,"timed_out"),input.timeoutMs);
  input.signal?.addEventListener("abort",aborted,{once:true});
  try {
    if(input.signal?.aborted)aborted();
    const turn=await Promise.race([input.send(),cancellation]);
    if(interruption) {
      const terminal=await interruption;
      if(terminal.status==="in_progress"||!terminal.completedAt)
        throw new Error("Profile evaluation cleanup remains unconfirmed.");
    }
    if(turn.status==="in_progress"||!turn.completedAt)throw new Error("Workflow evaluation turn did not settle.");
    return turn;
  } catch(error) {
    if(interruption) {
      const terminal=await interruption;
      if(terminal.status==="in_progress"||!terminal.completedAt)throw new Error("Profile evaluation cleanup remains unconfirmed.",{cause:error});
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort",aborted);
  }
}
