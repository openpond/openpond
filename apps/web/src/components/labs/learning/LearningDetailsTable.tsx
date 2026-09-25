import type { ReactNode } from "react";

/** The same bordered table used for inventories, with field names in the first column. */
export function LearningDetailsTable({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <div className="models-table-wrap"><table className="models-data-table"><tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row" className="w-44">{label}</th><td className="break-words">{value}</td></tr>)}</tbody></table></div>;
}
