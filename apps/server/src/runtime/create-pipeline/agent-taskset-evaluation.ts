import {
  TaskAttemptResultSchema,
  type CreateImproveRun,
  type GradeResult,
  type TaskAttemptResult,
  type Taskset,
} from "@openpond/contracts";
import { runAgentSdkProjectCommand } from "@openpond/cloud";
import { contentHash } from "@openpond/taskset-sdk";

import { assertTasksetRefMatches } from "../../training/create-improve-taskset-lineage.js";

export type AgentTasksetGrade = (input: {
  tasksetId: string;
  taskId: string;
  attempt: TaskAttemptResult;
}) => Promise<GradeResult>;

export type AgentTasksetExecution = {
  taskAttemptRefs: string[];
  gradeRefs: string[];
  taskRefs: string[];
  artifactRefs: string[];
  total: number;
  passed: number;
  failed: number;
  executionContractHash: string;
};

export async function executeAgentTasksetEvaluation(input: {
  run: CreateImproveRun;
  taskset: Taskset;
  cwd: string;
  sourceCommit: string;
  subject: "active" | "candidate" | "post_release" | "standalone";
  gradeAttempt: AgentTasksetGrade;
  execute?: typeof runAgentSdkProjectCommand;
}): Promise<AgentTasksetExecution> {
  const tasksetRef = input.run.tasksetRef;
  if (!tasksetRef) throw new Error("Agent Taskset execution requires an approved Taskset ref.");
  assertTasksetRefMatches(tasksetRef, input.taskset);
  if (input.taskset.environment.kind !== "agent") {
    throw new Error(`Taskset ${input.taskset.id} is not an Agent-shaped Taskset.`);
  }
  const privateRefs = new Set(tasksetRef.privateSplitRefs);
  const tasks = input.taskset.tasks.filter((task) => privateRefs.has(task.id));
  if (!tasks.length || tasks.length !== privateRefs.size) {
    throw new Error("The approved Agent Taskset private split could not be resolved exactly.");
  }
  const executionContract = {
    tasksetId: tasksetRef.id,
    tasksetRevision: tasksetRef.revision,
    tasksetHash: tasksetRef.contentHash,
    taskRefs: tasks.map((task) => task.id),
    seed: 0,
    timeoutMs: input.taskset.environment.defaultTimeoutMs,
    entrypoint: input.taskset.environment.entrypoint,
    evaluator: "openpond-agent-sdk-taskset.v1",
  };
  const executionContractHash = contentHash(executionContract);
  const grades: GradeResult[] = [];
  const taskAttemptRefs: string[] = [];
  const artifactRefs: string[] = [];
  for (const task of tasks) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result = await (input.execute ?? runAgentSdkProjectCommand)({
      cwd: input.cwd,
      command: "run",
      args: [
        input.taskset.environment.entrypoint,
        "--json",
        "--input",
        JSON.stringify({ ...task.input, channel: "manual" }),
      ],
      timeoutMs: input.taskset.environment.defaultTimeoutMs,
      throwOnFailure: false,
    });
    const parsed = result.code === 0 ? parseAgentRunPayload(result.stdout) : null;
    const attemptId = `agent_task_attempt_${contentHash([
      input.run.id,
      input.subject,
      input.sourceCommit,
      tasksetRef.contentHash,
      task.id,
      0,
    ]).slice(0, 24)}`;
    const traceRef = stringValue(parsed?.traceArtifactRef);
    const attempt = TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: input.taskset.id,
      taskId: task.id,
      split: task.split,
      attempt: 0,
      seed: 0,
      modelRef: null,
      startedAt,
      completedAt: new Date().toISOString(),
      output: recordValue(parsed?.result),
      runtimeEventRefs: traceRef ? [traceRef] : [],
      artifactRefs: traceRef ? [traceRef] : [],
      privilegedOutcomeRef: task.privilegedContextRef,
      infrastructureError: result.code === 0
        ? null
        : result.stderr.trim().slice(0, 10_000) || `Agent SDK action exited with code ${String(result.code)}.`,
      costUsd: 0,
      latencyMs: Math.max(0, Date.now() - started),
      userInterventions: 0,
      metadata: {
        executor: "openpond-agent-sdk",
        trustedTasksetExecution: true,
        tasksetRevision: tasksetRef.revision,
        tasksetHash: tasksetRef.contentHash,
        sourceCommit: input.sourceCommit,
        subject: input.subject,
        executionContractHash,
      },
    });
    const grade = await input.gradeAttempt({
      tasksetId: input.taskset.id,
      taskId: task.id,
      attempt,
    });
    taskAttemptRefs.push(attempt.id);
    grades.push(grade);
    if (traceRef) artifactRefs.push(traceRef);
  }
  const passed = grades.filter((grade) => grade.passed).length;
  return {
    taskAttemptRefs,
    gradeRefs: grades.map((grade) => grade.id),
    taskRefs: tasks.map((task) => task.id),
    artifactRefs: [...new Set(artifactRefs)],
    total: grades.length,
    passed,
    failed: grades.length - passed,
    executionContractHash,
  };
}

function parseAgentRunPayload(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return recordValue(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return recordValue(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
