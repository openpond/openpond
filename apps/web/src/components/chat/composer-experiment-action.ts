import type { ChatResourceSummary } from "@openpond/contracts";

// A changed or unknown configuration must never reuse a completed score as
// evidence for the current draft. Regrading is not supported by the run API.
export function experimentAction(input: {
  isExperiment:boolean; dataset:ChatResourceSummary|null; graders:number;
  executionLocation?:"local"|"cloud"; model?:string; modelAvailable:boolean; run?:ChatResourceSummary|null;
}) {
  const {dataset,run,model}=input;
  if (!input.isExperiment) return "New experiment";
  if (run && /^(running|queued|pending|starting)$/i.test(run.state)) return "View progress";
  if (!dataset || dataset.taskCount===0 || !input.graders || !model || !input.modelAvailable) return "Set up";
  if (!run) return "Run";
  const sameOwner = dataset.owner?.teamId===run.owner?.teamId && dataset.owner?.actorId===run.owner?.actorId
    && JSON.stringify(dataset.profileRef)===JSON.stringify(run.profileRef);
  const unchanged = (input.executionLocation ?? "local") === (run.location ?? "local") && sameOwner && dataset.id===run.datasetId && model===run.model
    && (dataset.evaluationHash && run.evaluationHash ? dataset.evaluationHash===run.evaluationHash : dataset.revision===run.datasetRevision);
  if (!unchanged) return "Run updated";
  return /^(completed|complete|succeeded)$/i.test(run.state) ? "Improve" : "Retry";
}
