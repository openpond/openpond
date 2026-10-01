import type { GraderUsagePageSchema, RewardRelease } from "openpond-sdk/learning";
import type { z } from "zod";
import { EvaluationTableState } from "./EvaluationTableState";
export function GraderVersionsTable({ items, loading, error, retry, onSelect }: { items: RewardRelease[]; loading: boolean; error?: string; retry:()=>void; onSelect:(item:RewardRelease)=>void }) {
 return <table className="training-data-table evaluation-workspace-table"><thead><tr><th>Version</th><th>Name</th><th>Feedback key</th><th>Release hash</th></tr></thead><tbody>{items.map(item=><tr key={item.revision}><td><button className="training-text-button" onClick={()=>onSelect(item)}>Revision {item.revision}</button></td><td>{item.name}</td><td>{item.feedbackKey}</td><td>{item.contentHash}</td></tr>)}<EvaluationTableState columns={4} loading={loading} error={error} empty={!items.length} retry={retry}>Publish a Grader version to retain its immutable release here.</EvaluationTableState></tbody></table>;
}
export function GraderUsageTable({ items, loading, error, retry }: { items:z.infer<typeof GraderUsagePageSchema>["items"]; loading:boolean; error?:string; retry:()=>void }) {
 return <table className="training-data-table evaluation-workspace-table"><thead><tr><th>Name</th><th>Version or status</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{item.name}</td><td>{"graderRevisions" in item ? `Revisions ${item.graderRevisions.join(", ")}` : "status" in item ? item.status : "Unknown"}</td></tr>)}<EvaluationTableState columns={2} loading={loading} error={error} empty={!items.length} retry={retry}>Use this Grader in a Dataset, Project or Experiment to retain its association here.</EvaluationTableState></tbody></table>;
}
