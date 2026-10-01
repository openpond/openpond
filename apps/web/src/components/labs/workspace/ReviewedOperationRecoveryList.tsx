import type {EvaluationOperationRecovery} from "@openpond/contracts";
export function ReviewedOperationRecoveryList({items,busy,error,onRestore,onDiscard,onLoadMore}:{items:EvaluationOperationRecovery[];busy:boolean;error?:string;onRestore:(row:EvaluationOperationRecovery)=>void;onDiscard:(row:EvaluationOperationRecovery)=>void;onLoadMore?:()=>void}){
  return <section aria-label="Retained reviewed operations">
    {error?<p role="alert">{error}</p>:null}
    {items.length?<><h3>Retained operations</h3><p>Restore the original reviewed command before retrying an uncertain request. Changing the setup does not replace that command.</p></>:null}
    {items.map(row=><div key={row.id}>
      <p>{row.id} / {row.phase??"recovery unavailable"} / {row.createdAt}</p>
      {row.recoveryReady?<button type="button" disabled={busy} onClick={()=>onRestore(row)}>Restore original command</button>:<p>The original command was not retained. Recover its actual receipt before starting another operation.</p>}
      {row.phase==="reviewed"?<button type="button" disabled={busy} onClick={()=>onDiscard(row)}>Discard unstarted review</button>:null}
    </div>)}
    {onLoadMore?<button type="button" disabled={busy} onClick={onLoadMore}>Load more retained operations</button>:null}
  </section>;
}
