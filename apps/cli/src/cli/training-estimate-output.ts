import type { TrainingEstimate } from "openpond-sdk/training";

const money = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4,
}).format(value);
const duration = (seconds: number) => seconds >= 3600
  ? `${(seconds / 3600).toFixed(1)} hours` : `${Math.max(1, Math.ceil(seconds / 60))} minutes`;

export function printTrainingEstimate(estimate: TrainingEstimate, json: boolean) {
  if (json) { console.log(JSON.stringify(estimate, null, 2)); return; }
  console.log(`Estimate ${estimate.id} (${estimate.status.replaceAll("_", " ")})`);
  console.log(`Model: ${estimate.configuration.modelId}@${estimate.configuration.modelRevision}`);
  const config = estimate.configuration;
  console.log(`Configuration: ${config.method}${config.loraRank === null ? "" : `, rank ${config.loraRank}`}${config.groups === null ? "" : `, ${config.groups} groups`}${config.rolloutConcurrency === null ? "" : `, ${config.rolloutConcurrency} rollout lanes`}${config.adapterMode === null ? "" : `, ${config.adapterMode}`}`);
  console.log(`GPU: ${estimate.gpu.resolved?.gpuType ?? "Awaiting a supported offering"} (${estimate.gpu.requested.mode}, ${estimate.gpu.availability})`);
  const cost = estimate.cost;
  console.log(`Expected cost: ${cost.expectedUsd === null ? "Not yet calibrated" : money(cost.expectedUsd)}`);
  if (cost.planningRangeUsd) console.log(`Planning range: ${money(cost.planningRangeUsd.low)}–${money(cost.planningRangeUsd.high)}`);
  console.log(`Execution time: ${estimate.executionSeconds.expected === null ? "Not yet calibrated" : duration(estimate.executionSeconds.expected)}`);
  console.log(`Queue wait: ${estimate.queueWaitSeconds === null ? "Start time not yet known" : `about ${duration(estimate.queueWaitSeconds.expected)}`}`);
  console.log(`Recommended maximum budget: ${cost.recommendedMaximumUsd === null ? "Unavailable with current evidence" : money(cost.recommendedMaximumUsd)}`);
  console.log(`Approved hard cap: ${config.approvedMaximumUsd === null ? "Not approved" : money(config.approvedMaximumUsd)}`);
  if (config.approvedMaximumUsd !== null && cost.expectedUsd !== null && cost.expectedUsd > config.approvedMaximumUsd)
    console.log("Expected cost exceeds the approved cap. Change the run or explicitly approve a different budget before submission.");
  for (const component of cost.components) {
    if (component.expectedUsd !== null) console.log(`  ${component.phase.replaceAll("_", " ")} / ${component.resource}: ${money(component.expectedUsd)}`);
  }
  for (const assumption of estimate.assumptions) console.log(`Assumption: ${assumption}`);
  for (const unknown of estimate.unknowns) console.log(`Unknown: ${unknown}`);
  console.log(`Evidence: ${estimate.calibration.completedSamples} completed, ${estimate.calibration.partialSamples} partial samples; expires ${estimate.expiresAt}`);
  console.log("This estimate reserves no resources and approves no spending.");
}
