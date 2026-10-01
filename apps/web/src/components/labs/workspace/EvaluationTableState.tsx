import type { ReactNode } from "react";
export function EvaluationTableState({ columns, loading, error, empty, children, retry }: { columns: number; loading?: boolean; error?: string | null; empty?: boolean; children?: ReactNode; retry?: () => void }) {
  if(loading && !error) return <>{Array.from({length:5},(_,row)=><tr key={row} aria-hidden="true">{Array.from({length:columns},(_,col)=><td key={col}><span className="evaluation-table-skeleton" /></td>)}</tr>)}<tr className="sr-only"><td colSpan={columns} role="status">Loading table rows…</td></tr></>;
  if(!empty && !error) return null;
  return <tr><td colSpan={columns}><div className="evaluation-table-empty" role={error ? "alert" : undefined}>{error ?? children}{error && retry ? <button type="button" className="training-text-button" onClick={retry}>Retry</button> : null}</div></td></tr>;
}
