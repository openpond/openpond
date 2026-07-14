import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CrossSystemBootstrapRecordSchema,
  type CrossSystemBootstrapMessage,
  type CrossSystemBootstrapRecord,
  type CrossSystemTrajectory,
  type CrossSystemVerifierResult,
} from "@openpond/contracts";
import type { CrossSystemTask } from "./types.js";

export function buildCrossSystemBootstrapDataset(input: {
  tasks: CrossSystemTask[];
  trajectories: CrossSystemTrajectory[];
  results: CrossSystemVerifierResult[];
  approvedTrajectoryIds: Iterable<string>;
  approvedBy: string;
  approvedAt: string;
}): CrossSystemBootstrapRecord[] {
  const approved = new Set(input.approvedTrajectoryIds);
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const resultByTrajectory = new Map(input.results.map((result) => [result.trajectoryId, result]));
  return input.trajectories.flatMap((trajectory) => {
    const result = resultByTrajectory.get(trajectory.id);
    const task = taskById.get(trajectory.taskId);
    if (!approved.has(trajectory.id) || !task || result?.outcome !== "correct" || !result.rewardEligible) return [];
    return [CrossSystemBootstrapRecordSchema.parse({
      schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
      id: `cso_bootstrap_${trajectory.id}`,
      taskId: task.id,
      worldId: trajectory.worldId,
      trajectoryId: trajectory.id,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      approval: { status: "approved", approvedBy: input.approvedBy, approvedAt: input.approvedAt },
      messages: trajectoryMessages(task, trajectory),
    })];
  });
}

function trajectoryMessages(task: CrossSystemTask, trajectory: CrossSystemTrajectory): CrossSystemBootstrapMessage[] {
  const messages: CrossSystemBootstrapMessage[] = [
    { role: "system", content: `Use only the four registered synthetic Cross-System Operations tools. Contract ${CROSS_SYSTEM_TOOL_CONTRACT_HASH}. Finish with ANSWER: JSON.` },
    { role: "user", content: task.prompt },
  ];
  for (const step of trajectory.steps) {
    if (step.kind === "model" && step.content.trim()) messages.push({ role: "assistant", content: step.content });
    if (step.kind === "tool_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: step.callId, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }],
      });
    }
    if (step.kind === "tool_result") messages.push({ role: "tool", tool_call_id: step.callId, content: JSON.stringify({ ok: step.ok, result: step.result, error: step.error }) });
    if (step.kind === "final") messages.push({ role: "assistant", content: step.content });
  }
  return messages;
}
