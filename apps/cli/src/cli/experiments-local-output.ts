import {ChatResourceSummarySchema,LocalExperimentRecordSchema} from "@openpond/contracts";

/** Human output is a projection of the same retained response used by --json. */
export function printLocalExperimentResult(value:unknown) {
  const object=value && typeof value==="object" ? value as Record<string,unknown> : {};
  const summaries=[object.summary,...Array.isArray(object.summaries) ? object.summaries : []].flatMap(value=>{const summary=ChatResourceSummarySchema.safeParse(value);return summary.success ? [summary.data] : [];});
  if(summaries.length) {
    for(const summary of summaries) {
      console.log(`${summary.name} · ${summary.state}`);
      console.log(`${summary.id} · ${summary.location ?? "local"} · Dataset ${summary.datasetId} version ${summary.datasetRevision} · ${summary.model}`);
      console.log(`${summary.scoreLabel ?? "Mean task score"}: ${summary.score == null ? "Unavailable" : (summary.score*100).toFixed(1)+"%"} · Graded: ${summary.evaluatedCount ?? 0}/${summary.taskCount ?? 0} · Cost: ${summary.costUsd == null ? "Unavailable" : "$"+summary.costUsd.toFixed(4)}`);
      console.log(`Quality failures: ${summary.qualityFailureCount ?? 0} · Execution failures: ${summary.executionFailureCount ?? 0} · Ungraded: ${summary.ungradedCount ?? summary.taskCount ?? 0}`);
      if(summary.rows.length)console.table(summary.rows.map(row=>({Task:row.label,Outcome:row.detail,Score:row.score==null ? "Unavailable" : (row.score*100).toFixed(1)+"%"})));
      console.log(`Results: openpond experiments result ${summary.id} --local`);
    }
    if(Array.isArray(object.items)) console.table(object.items.flatMap(value=>{const record=LocalExperimentRecordSchema.safeParse(value);return record.success ? [{ID:record.data.id,Name:record.data.configuration.request.name,Model:record.data.model.modelId,Status:record.data.status}] : [];}));
    for(const error of Array.isArray(object.errors) ? object.errors as {modelId:string;message:string}[] : [])console.log(`Admission failed: ${error.modelId} · ${error.message}`);
    return;
  }
  if(Array.isArray(object.models)){console.table(object.models);return;}
  if(Array.isArray(object.items)) {
    console.table(object.items.flatMap(value=>{const record=LocalExperimentRecordSchema.safeParse(value);return record.success ? [{ID:record.data.id,Name:record.data.configuration.request.name,Model:record.data.model.modelId,Status:record.data.status}] : [];}));return;
  }
  // Detailed case/comparison evidence retains its structured shape. It cannot
  // be summarized into a winner without the canonical comparison result.
  console.log(JSON.stringify(value,null,2));
}
