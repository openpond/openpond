import { optimizerReceiptFacts } from "./hosted-run-recovery-evidence.js";
import type { RunStageEvidence } from "@openpond/contracts";
import type { HostedStageDetail } from "./hosted-run-stage-evidence.js";

type Fact = NonNullable<RunStageEvidence["nodes"][number]["diagnostics"]>[number];
const commands: Record<string, string[]> = {
  Prepare: ["start_inference"], "Load parent adapter": ["materialize_checkpoint"],
  "Update adapter": ["train_step"], "Save checkpoint": ["upload_checkpoint", "qualify_checkpoint"],
  "Activate policy": ["start_inference"], Grade: ["score_reward_model"], Finish: ["stop"],
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const indexes = new WeakMap<HostedStageDetail, ReturnType<typeof buildIndex>>();
function buildIndex(detail: HostedStageDetail) {
  const attemptsByGroup = new Map<string, HostedStageDetail["rollouts"]>();
  for (const attempt of detail.rollouts) { const group = attemptsByGroup.get(attempt.groupId) ?? []; group.push(attempt); attemptsByGroup.set(attempt.groupId, group); }
  return { attemptsByGroup, rollout: new Map(detail.rollouts.map(item => [item.id, item])), trajectory: new Map(detail.trajectories.map(item => [item.rolloutId, item])) };
}
function index(detail: HostedStageDetail) { const value = indexes.get(detail) ?? buildIndex(detail); indexes.set(detail, value); return value; }
const metricNumber = (value: unknown) => (typeof value === "number" || typeof value === "string" && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
function fact(label: string, value: unknown, severity: Fact["severity"] = "info"): Fact {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "Not retained";
  return { label, value: text.length > 4000 ? `${text.slice(0, 3960)}… (retained excerpt)` : text, severity };
}

/** Private post-attempt grader differences stay in evidence, never in learner input. */
function graderDifferences(components: Record<string, unknown>): Fact[] {
  const facts: Fact[] = [];
  let visited = 0;
  const visit = (value: unknown, depth: number, key = "") => {
    if (depth > 8 || ++visited > 2000 || facts.length >= 80) return;
    if (typeof value === "string" && key === "feedback" && value.length < 512000) {
      try { visit(JSON.parse(value), depth + 1); } catch { /* Plain feedback remains available in the retained excerpt. */ }
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    const object = record(value);
    const diagnostics = record(object.diagnostics);
    if (Array.isArray(diagnostics.differences)) for (const difference of diagnostics.differences.slice(0, 80 - facts.length)) {
      const item = record(difference);
      if (typeof item.kind !== "string" || typeof item.path !== "string") continue;
      facts.push(fact(`${item.kind.replaceAll("_", " ")} · ${item.path}`,
        `Expected: ${JSON.stringify(item.expected) ?? "Not retained"}\nActual: ${JSON.stringify(item.actual) ?? "Not retained"}`, "warning"));
    }
    for (const [name, child] of Object.entries(object)) if (name !== "diagnostics") visit(child, depth + 1, name);
  };
  visit(components, 0);
  return facts;
}

/** Project only run evidence fields; never worker credentials, task inputs, or provider metadata. */
export function attemptDiagnostics(detail: HostedStageDetail, rolloutId: string): Fact[] {
  const data = index(detail);
  const rollout = data.rollout.get(rolloutId);
  const trajectory = data.trajectory.get(rolloutId);
  if (!rollout) return [];
  const result = [fact("Attempt execution", rollout.state), fact("Rollout ID", rollout.id)];
  if (rollout.policyVersion !== undefined) result.push(fact("Policy version", rollout.policyVersion));
  if (trajectory) {
    result.push(fact("Reward", trajectory.reward ?? "Not scored"));
    if (typeof trajectory.rewardEligible === "boolean") result.push(fact("Training eligibility", trajectory.rewardEligible ? "Eligible" : "Not eligible", trajectory.rewardEligible ? "info" : "warning"));
    if (trajectory.terminalClass) result.push(fact("Terminal class", trajectory.terminalClass));
    const components = record(trajectory.rewardComponents);
    if (Object.keys(components).length) result.push(fact("Retained reward components", components));
    result.push(...graderDifferences(components));
  } else result.push(fact("Grader feedback", "No trajectory or grading receipt retained for this attempt."));
  for (const key of ["errorCode", "failureReason", "terminalReason"] as const) if (typeof rollout[key] === "string") result.push(fact(key, rollout[key], "warning"));
  return result.slice(0, 100);
}

export function groupDiagnostics(detail: HostedStageDetail, groupId: string, state: string): Fact[] {
  const data = index(detail);
  const attempts = data.attemptsByGroup.get(groupId) ?? [];
  const trajectories = attempts.flatMap(item => { const trajectory = data.trajectory.get(item.id); return trajectory ? [trajectory] : []; });
  const scored = trajectories.filter(item => item.reward !== null && Number.isFinite(Number(item.reward)));
  const group = detail.rolloutGroups.find(item => item.id === groupId);
  const steps = detail.trainingSteps.filter(step => step.groupId === groupId || trajectories.some(item => item.consumedTrainingStepId === step.id));
  const failed = attempts.filter(item => /failed|cancelled|timed_out|expired/.test(item.state));
  return [fact("Group execution", state), fact("Retained attempts", attempts.length),
    fact("Group mean reward", group?.rewardMean ?? "Not retained"),
    ...(group?.policyVersion !== undefined ? [fact("Input policy", group.policyVersion)] : []),
    ...(group?.eligibleTrajectoryCount !== undefined ? [fact("Eligible trajectories recorded by group", group.eligibleTrajectoryCount)] : []),
    fact("Scored trajectories", scored.length), fact("Failed attempts", failed.length, failed.length ? "warning" : "info"),
    fact("Reward range", scored.length ? `${Math.min(...scored.map(item => Number(item.reward)))} – ${Math.max(...scored.map(item => Number(item.reward)))}` : "No scored trajectories"),
    fact("Retained trajectory eligibility", `${trajectories.filter(item => item.rewardEligible === true).length} eligible · ${trajectories.filter(item => item.rewardEligible === false).length} ineligible · ${trajectories.filter(item => typeof item.rewardEligible !== "boolean").length} not retained`),
    ...(steps.length ? steps.slice(-10).flatMap(step => [fact("Optimizer step", `${step.id} · ${step.state}`, step.state.startsWith("failed") ? "warning" : "info"),
      ...(step.inputPolicyVersion !== undefined && step.outputPolicyVersion !== undefined ? [fact("Policy transition", `v${step.inputPolicyVersion} → v${step.outputPolicyVersion}`)] : []),
      ...(Object.keys(record(step.metrics)).length ? [fact("Retained optimizer metrics", step.metrics)] : []),
    ]) : [fact("Optimizer evidence", "No optimizer-step record retained for this group.")]),
  ].slice(0, 100);
}

export function stageDiagnostics(detail: HostedStageDetail, label: string): Fact[] {
  const result: Fact[] = [fact("Meaning of execution status", "Recorded or completed describes execution evidence. It does not mean the model passed quality evaluation.")];
  for (const command of detail.commands.filter(item => commands[label]?.includes(item.commandType)).slice(-20)) {
    result.push(fact(command.commandType, command.state, command.state === "failed" ? "error" : "info"));
    if (command.errorCode) result.push(fact("Retained command error", command.errorCode, "error"));
    result.push(fact("Command updated", command.updatedAt));
    for (const key of ["timings", "inferenceDiagnostics", "inferenceFailureOutput", "contextAdmission"] as const) {
      if (command[key] !== undefined && command[key] !== null) result.push(fact(key, command[key], key === "inferenceFailureOutput" ? "warning" : "info"));
    }
  }
  if (["Rollouts", "Grade"].includes(label)) for (const group of detail.rolloutGroups.slice(-8)) result.push(...groupDiagnostics(detail, group.id, group.state).map(item => ({ ...item, label: `Group ${group.groupIndex + 1} · ${item.label}` })));
  if (["Evaluate", "Baseline evaluation"].includes(label)) {
    const evaluations = detail.evaluations.filter(item => item.kind === (label === "Evaluate" ? "candidate" : "baseline"));
    if (!evaluations.length) result.push(fact("Evaluation evidence", "No evaluation receipt retained for this stage; quality is not established."));
    for (const evaluation of evaluations) {
      result.push(fact("Evaluation execution", evaluation.state, /failed|cancelled|timed_out/.test(evaluation.state) ? "error" : "info"), fact("Score", evaluation.score ?? "Not retained"));
      const metrics = record(evaluation.metrics);
      const improvement = metricNumber(metrics.improvement), improvementThreshold = metricNumber(metrics.improvementThreshold);
      if (evaluation.kind === "baseline") result.push(fact("Baseline receipt", evaluation.state === "completed" ? "Baseline recorded" : evaluation.state));
      else if (improvement !== null && improvementThreshold !== null) {
        result.push(fact("Improvement comparison", `${metrics.improvement} · required ${metrics.improvementThreshold}`));
        result.push(fact("Improvement threshold outcome", evaluation.passed === true ? "Improvement threshold met" : evaluation.passed === false ? "Improvement threshold not met" : "No comparison verdict retained", evaluation.passed === false ? "warning" : "info"));
      } else if (typeof evaluation.passed === "boolean") result.push(fact("Recorded evaluation acceptance flag", `${evaluation.passed}; improvement comparison not retained`));
      const passRate = typeof metrics.passRate === "number" ? metrics.passRate : typeof metrics.passRate === "string" && metrics.passRate.trim() ? Number(metrics.passRate) : null;
      const taskCount = typeof metrics.taskCount === "number" && Number.isInteger(metrics.taskCount) && metrics.taskCount >= 0 ? metrics.taskCount : null;
      if (passRate !== null && Number.isFinite(passRate) && passRate >= 0 && passRate <= 1) {
        const passed = taskCount !== null && taskCount > 0 ? passRate * taskCount : null;
        const counts = passed !== null && Math.abs(passed - Math.round(passed)) < 0.000001 ? `${Math.round(passed)}/${taskCount} tasks` : taskCount !== null ? `${taskCount} tasks` : "Task count not retained";
        result.push(fact("Retained task pass rate", `${counts} · ${(passRate * 100).toFixed(1)}%`, passRate < 1 ? "warning" : "info"));
      }
      if (evaluation.metrics) {
        const summary: Record<string, unknown> = {};
        for (const key of ["passRate", "taskCount", "targetTaskCount", "comparison", "improvement", "baselineScore", "candidateScore", "improvementThreshold", "panelSha256", "rewardAssetsInRequest", "rolloutFilesystemUsed", "expectedAnswerInRequest"]) {
          const value = metrics[key];
          if (value === null || ["string", "number", "boolean"].includes(typeof value)) summary[key] = value;
        }
        if (Array.isArray(metrics.taskResults)) summary.taskResults = metrics.taskResults.slice(0, 100).map(value => {
          const task = record(value);
          return Object.fromEntries(["taskId", "taskSha256", "resultSha256", "score", "passed", "state", "status"].flatMap(key => task[key] === null || ["string", "number", "boolean"].includes(typeof task[key]) ? [[key, task[key]]] : []));
        });
        result.push(fact("Retained evaluation evidence", summary));
      }
    }
  }
  if (label === "Update adapter") for (const group of detail.rolloutGroups) {
    if (typeof group.optimizerDisposition === "string") result.push(fact("Optimizer disposition", group.optimizerDisposition));
    result.push(...optimizerReceiptFacts(record(group.optimizerEvidence)));
  }
  if (label === "Update adapter") for (const step of detail.trainingSteps.slice(-15)) {
    result.push(fact("Optimizer step", `${step.id} · ${step.state}`, /failed/.test(step.state) ? "error" : "info"));
    if (step.inputPolicyVersion !== undefined && step.outputPolicyVersion !== undefined) result.push(fact("Policy transition", `v${step.inputPolicyVersion} → v${step.outputPolicyVersion}`));
    result.push(fact("Optimizer commit", step.optimizerCommitSha256 ?? "No commit retained"));
    if (Object.keys(record(step.metrics)).length) result.push(fact("Retained optimizer metrics", step.metrics));
  }
  if (label === "Activate policy") for (const policy of detail.policyVersions.slice(-15)) {
    result.push(fact("Serving policy", `v${policy.version} · ${policy.served ? "Served" : "No serving attestation"}`));
    if (typeof policy.servedAttestationSha256 === "string") result.push(fact("Serving attestation", policy.servedAttestationSha256));
  }
  if (label === "Save checkpoint") for (const item of detail.checkpoints.slice(-10)) result.push(fact("Checkpoint", `${item.id ?? "ID not retained"} · ${item.state ?? "State not retained"}`));
  if (label === "Finish" && detail.job.terminalReason) result.push(fact("Run terminal reason", detail.job.terminalReason, detail.job.state === "completed" ? "info" : "warning"));
  return result.slice(0, 60);
}

export function stageFeedbackTargets(detail: HostedStageDetail, label: string): NonNullable<RunStageEvidence["nodes"][number]["feedback"]> {
  if (label === "Grade") return detail.trajectories.slice(-20).flatMap(item => typeof item.id === "string" ? [{ kind: "trajectory" as const, id: item.id }] : []);
  if (!["Evaluate", "Baseline evaluation"].includes(label)) return [];
  return detail.evaluations.filter(item => item.kind === (label === "Evaluate" ? "candidate" : "baseline")).flatMap(item => {
    const tasks = item.metrics?.taskResults;
    if (typeof item.id !== "string" || !Array.isArray(tasks)) return [];
    return tasks.flatMap(task => typeof record(task).taskId === "string" ? [{ kind: "evaluation" as const, id: item.id as string, taskId: record(task).taskId as string }] : []);
  }).slice(0, 100);
}
