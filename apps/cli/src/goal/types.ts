import type { CreateImproveRun } from "@openpond/contracts";

export type GoalKind =
  | "general_code_goal"
  | "fix_bug"
  | "add_feature"
  | "refactor"
  | "write_tests"
  | "create_project"
  | "update_project"
  | "create_agent"
  | "update_agent";

export type GoalProfile = "generic_coding" | "openpond_agent";

export type GoalStatus =
  | "queued"
  | "running"
  | "awaiting_user_input"
  | "awaiting_approval"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_limited";

export type GoalExecutionPolicy = {
  sourceUpdates: "propose_only" | "auto_commit_push_default_branch";
  externalEffects: "approval_required" | "full_auto";
  budgetEscalation: "approval_required";
};

export type GoalVerification = {
  commands: string[];
  requiredChecks: string[];
  successCriteria: string[];
  regressionPolicy: "none" | "existing_checks_must_pass";
  artifactRefs: string[];
};

export type GoalBudget = {
  maxIterations: number;
  maxRuntimeMinutes: number | null;
  maxModelCostUsd: number | null;
};

export type GoalEvidenceRef =
  | { kind: "conversation"; id: string }
  | { kind: "message"; id: string }
  | { kind: "agent_run"; id: string }
  | { kind: "trace_artifact"; ref: string }
  | { kind: "check_result"; ref: string }
  | { kind: "source_ref"; ref: string; commitSha?: string | null }
  | { kind: "manifest_hash"; hash: string };

export type GoalQuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type GoalQuestion = {
  id: string;
  goalId: string;
  title: string;
  reason: string;
  required: boolean;
  options: GoalQuestionOption[];
  freeformAllowed: boolean;
  answeredAt: string | null;
};

export type GoalAnswer = {
  id: string;
  goalId: string;
  questionId: string;
  optionId: string | null;
  freeformText: string | null;
  value: Record<string, unknown>;
  createdAt: string;
};

export type GoalApprovalKind =
  | "create_plan"
  | "deploy_publish"
  | "integration_write"
  | "secret_or_env_change"
  | "budget_escalation"
  | "external_effect";

export type GoalApprovalRequest = {
  goalId: string;
  kind: GoalApprovalKind;
  title: string;
  reason: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type GoalApproval = GoalApprovalRequest & {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decidedAt: string | null;
  decisionNote: string | null;
};

export type GoalEventKind =
  | "goal.created"
  | "goal.status_changed"
  | "iteration.started"
  | "iteration.completed"
  | "question.created"
  | "question.answered"
  | "approval.requested"
  | "approval.decided"
  | "create_pipeline.created"
  | "create_pipeline.status_changed"
  | "create_plan.created"
  | "workflow_capture.created"
  | "command.started"
  | "command.completed"
  | "check.completed"
  | "source.updated"
  | "artifact.created"
  | "model.usage"
  | "goal.blocked"
  | "goal.failed";

export type GoalEvent = {
  id: string;
  goalId: string;
  iterationId: string | null;
  kind: GoalEventKind;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type GoalCommandResult = {
  command: string;
  cwd: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  artifactRefs: string[];
  startedAt: string;
  completedAt: string;
};

export type GoalCheckStatus = "passed" | "failed" | "skipped";

export type GoalCheckResult = {
  id: string;
  goalId: string;
  iterationId: string | null;
  name: string;
  command: string;
  status: GoalCheckStatus;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  summary: string;
  artifactRefs: string[];
  startedAt: string;
  completedAt: string;
};

export type GoalArtifact = {
  id: string;
  goalId: string;
  iterationId: string | null;
  kind: "command_log" | "check_log" | "patch" | "trace" | "manifest" | "result";
  name: string;
  mimeType: string;
  content: string;
  bytes: number;
  createdAt: string;
};

export type GoalArtifactRef = {
  id: string;
  ref: string;
  kind: GoalArtifact["kind"];
  name: string;
  mimeType: string;
  bytes: number;
};

export type GoalLlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type GoalLlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type GoalLlmRequest = {
  goalId: string;
  iterationId: string;
  promptPack: string;
  messages: GoalLlmMessage[];
  tools?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export type GoalLlmResponse = {
  message?: GoalLlmMessage;
  toolCalls?: GoalLlmToolCall[];
  status?: "ok" | "needs_user_input" | "blocked";
  summary?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
};

export type GoalState = {
  id: string;
  teamId: string | null;
  projectId: string | null;
  agentId: string | null;
  workItemId: string | null;
  conversationId: string | null;
  sandboxId: string | null;
  runtimeId: string | null;
  kind: GoalKind;
  profile: GoalProfile;
  promptPack: string;
  objective: string;
  status: GoalStatus;
  executionPolicy: GoalExecutionPolicy;
  verification: GoalVerification;
  constraints: string[];
  evidenceRefs: GoalEvidenceRef[];
  budget: GoalBudget;
  questions: GoalQuestion[];
  answers: GoalAnswer[];
  approvals: GoalApproval[];
  createImproveRun?: CreateImproveRun;
  events: GoalEvent[];
  createdAt: string;
  updatedAt: string;
};

export type GoalRunConfig = {
  goal: GoalState;
  apiUrl?: string | null;
  mode: "local" | "hosted";
  workspace?: string | null;
  storageRoot?: string | null;
  iterationId?: string | null;
};

export type GoalRunResult = {
  goalId: string;
  status: GoalStatus;
  summary: string;
  events: GoalEvent[];
};
