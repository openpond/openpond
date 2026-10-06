import type { ProfileEvaluationDiscovery } from "../../api";

export type EvaluationRun = ProfileEvaluationDiscovery["runs"][number];
export type EvaluationTarget = ProfileEvaluationDiscovery["definitions"][number]["target"];

export function targetLabel(target: EvaluationTarget): string {
  switch (target.kind) {
    case "profile": return "Complete Profile";
    case "workflow": return `Workflow · ${target.workflowId}`;
    case "skill": return `Skill · ${target.skillPath}`;
    case "agent_action": return `Agent action · ${target.actionId}`;
  }
}

export function displayTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

export function displayScore(value: number | null): string {
  return value === null ? "No score" : `${Math.round(value * 100)}%`;
}

export function modelLabel(run: EvaluationRun): string {
  return run.manifest.policy.kind === "model"
    ? `${run.manifest.policy.model.provider}/${run.manifest.policy.model.model}` : "Fixture";
}
