import path from "node:path";

import {
  type CreateImproveEvaluationReceipt,
  type CreateImproveRun,
  type Taskset,
} from "@openpond/contracts";
import { runAgentSdkProjectCommand } from "@openpond/cloud";
import {
  executeAgentTasksetEvaluation,
  type AgentTasksetGrade,
} from "./agent-taskset-evaluation.js";

type AgentEvalPayload = {
  schemaVersion?: unknown;
  schema?: unknown;
  project?: { name?: unknown; version?: unknown };
  source?: { configPath?: unknown; configHash?: unknown };
  summary?: { total?: unknown; passed?: unknown; failed?: unknown };
  publishGate?: {
    status?: unknown;
    total?: unknown;
    passed?: unknown;
    failed?: unknown;
    blockingFailures?: unknown;
  };
  results?: Array<{
    name?: unknown;
    status?: unknown;
    traceArtifactRef?: unknown;
    artifacts?: unknown;
    error?: unknown;
  }>;
};

export async function runNormalizedAgentEvaluation(input: {
  run: CreateImproveRun;
  cwd: string;
  sourceRef: string;
  sourceCommit: string;
  sourceBranch: string;
  candidateId: string | null;
  subject: CreateImproveEvaluationReceipt["subject"];
  timestamp?: string;
  execute?: typeof runAgentSdkProjectCommand;
  taskset?: Taskset | null;
  gradeAttempt?: AgentTasksetGrade;
}): Promise<CreateImproveEvaluationReceipt> {
  const result = await (input.execute ?? runAgentSdkProjectCommand)({
    cwd: input.cwd,
    command: "eval",
    args: ["--json"],
    throwOnFailure: false,
  });
  const payload = parseAgentEvalPayload(result.stdout);
  const total = numberValue(payload.summary?.total) ?? 0;
  const passed = numberValue(payload.summary?.passed) ?? 0;
  const failed = numberValue(payload.summary?.failed) ?? Math.max(0, total - passed);
  const publishGate = payload.publishGate?.status === "passed" ? "passed" : "failed";
  const results = Array.isArray(payload.results) ? payload.results : [];
  const sdkEvalRefs = results
    .map((evaluation) => stringValue(evaluation.name))
    .filter((value): value is string => Boolean(value));
  const artifactRefs = new Set<string>([
    path.posix.join(input.sourceRef, ".openpond/eval-results.json"),
  ]);
  for (const evaluation of results) {
    const trace = stringValue(evaluation.traceArtifactRef);
    if (trace) artifactRefs.add(path.posix.join(input.sourceRef, normalizeRef(trace)));
    for (const artifact of stringArray(evaluation.artifacts)) {
      artifactRefs.add(path.posix.join(input.sourceRef, normalizeRef(artifact)));
    }
  }
  const tasksetExecution = input.run.tasksetRef
    ? await executeAgentTasksetEvaluation({
        run: input.run,
        taskset: requireTaskset(input.taskset),
        cwd: input.cwd,
        sourceCommit: input.sourceCommit,
        subject: input.subject,
        gradeAttempt: requireGradeAttempt(input.gradeAttempt),
        execute: input.execute,
      })
    : null;
  for (const ref of tasksetExecution?.artifactRefs ?? []) artifactRefs.add(ref);
  const combinedTotal = total + (tasksetExecution?.total ?? 0);
  const combinedPassed = passed + (tasksetExecution?.passed ?? 0);
  const combinedFailed = failed + (tasksetExecution?.failed ?? 0);
  const evalRefs = [...new Set([...sdkEvalRefs, ...(tasksetExecution?.taskRefs ?? [])])];
  const combinedPublishGate = publishGate === "passed" && (tasksetExecution?.failed ?? 0) === 0
    ? "passed" as const
    : "failed" as const;
  const status = result.code === 0 && combinedFailed === 0 && combinedPublishGate === "passed"
    ? "passed"
    : "failed";
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    id: `agent_eval_${input.run.id}_${input.subject}_${input.sourceCommit.slice(0, 12)}`,
    candidateId: input.candidateId,
    target: input.run.target,
    evaluatorKind: "agent_sdk",
    subject: input.subject,
    sourceCommit: input.sourceCommit,
    sourceBranch: input.sourceBranch,
    tasksetId: input.run.tasksetRef?.id ?? null,
    tasksetHash: input.run.tasksetRef?.contentHash ?? null,
    taskAttemptRefs: tasksetExecution?.taskAttemptRefs ?? sdkEvalRefs,
    status,
    publishGate: combinedPublishGate,
    summaryCounts: { total: combinedTotal, passed: combinedPassed, failed: combinedFailed },
    evalRefs,
    artifactRefs: [...artifactRefs],
    summary: `${input.subject === "active" ? "Active" : input.subject === "candidate" ? "Candidate" : "Post-release"} Agent SDK and Taskset Evals: ${combinedPassed}/${combinedTotal} passed${combinedPublishGate === "failed" ? "; publish gate failed" : ""}.`,
    createdAt: timestamp,
    metadata: {
      schemaVersion: stringValue(payload.schemaVersion),
      schema: stringValue(payload.schema),
      project: {
        name: stringValue(payload.project?.name),
        version: stringValue(payload.project?.version),
      },
      source: {
        configPath: stringValue(payload.source?.configPath),
        configHash: stringValue(payload.source?.configHash),
      },
      publishGate: {
        total: numberValue(payload.publishGate?.total),
        passed: numberValue(payload.publishGate?.passed),
        failed: numberValue(payload.publishGate?.failed),
        blockingFailures: stringArray(payload.publishGate?.blockingFailures),
      },
      command: {
        code: result.code,
        timedOut: result.timedOut,
        stderr: result.stderr.trim().slice(0, 4_000),
      },
      trustedTasksetExecution: Boolean(tasksetExecution),
      tasksetRevision: input.run.tasksetRef?.revision ?? null,
      executionContractHash: tasksetExecution?.executionContractHash ?? null,
      gradeRefs: tasksetExecution?.gradeRefs ?? [],
      results: results.map((evaluation) => ({
        name: stringValue(evaluation.name),
        status: stringValue(evaluation.status),
        error: stringValue(evaluation.error),
        traceArtifactRef: stringValue(evaluation.traceArtifactRef),
      })),
    },
  };
}

function requireTaskset(value: Taskset | null | undefined): Taskset {
  if (!value) throw new Error("The approved Agent Taskset could not be resolved for evaluation.");
  return value;
}

function requireGradeAttempt(value: AgentTasksetGrade | undefined): AgentTasksetGrade {
  if (!value) throw new Error("Trusted Taskset grading is unavailable for Agent evaluation.");
  return value;
}

function parseAgentEvalPayload(stdout: string): AgentEvalPayload {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Agent SDK Eval returned no JSON output.");
  try {
    return JSON.parse(trimmed) as AgentEvalPayload;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as AgentEvalPayload;
      } catch {
        // Fall through to the stable error below.
      }
    }
    throw new Error("Agent SDK Eval returned invalid JSON output.");
  }
}

function normalizeRef(value: string): string {
  return value.replace(/^\.\//, "").replaceAll("\\", "/");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}
