import {
  CreateImproveRunSchema,
  type CreateImproveRun,
} from "@openpond/contracts";

export const CREATE_IMPROVE_FIXTURE_TIMESTAMP = "2026-07-01T10:00:00.000Z";

export function createImproveRunFixture(
  overrides: Partial<CreateImproveRun> & {
    plan?: CreateImproveRun["plan"];
  } = {},
): CreateImproveRun {
  const id = overrides.id ?? "create_improve_fixture";
  const operation = overrides.operation ?? "create";
  const target = overrides.target ?? {
    kind: "agent" as const,
    id: "fixture-agent",
    displayName: "Fixture Agent",
    defaultActionKey: "fixture-agent.chat",
  };
  const state = overrides.state ?? "planning";
  const approvalId = `approval_${id}`;
  const plan = overrides.plan === undefined
    ? state === "planning"
      ? null
      : {
          schemaVersion: "openpond.createImprove.plan.v1" as const,
          id: `plan_${id}`,
          runId: id,
          status: [
            "applying_source",
            "running_checks",
            "evaluating",
            "awaiting_promotion",
            "opening_pull_request",
            "pull_request_open",
            "reconciling_release",
            "released",
            "rejected",
            "ready",
            "ready_local",
          ].includes(state)
            ? "approved" as const
            : "pending_approval" as const,
          objective: overrides.objective ?? "Create a fixture workproduct.",
          summary: "Create the fixture workproduct.",
          capturedContextSummary: "Fixture context.",
          defaultChatAction: {
            key: target.kind === "agent" ? target.defaultActionKey : null,
            label: target.displayName,
            required: target.kind === "agent",
          },
          sourcePlan: [],
          requirements: [],
          checks: [],
          approvalId,
          approvedAt: null,
          editedFromPlanId: null,
          metadata: {},
          createdAt: CREATE_IMPROVE_FIXTURE_TIMESTAMP,
          updatedAt: CREATE_IMPROVE_FIXTURE_TIMESTAMP,
        }
    : overrides.plan;

  return CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id,
    revision: 0,
    operation,
    surface: operation === "improve" ? "direct_prompt_improve" : "direct_prompt_create",
    command: operation === "improve" ? "/edit" : "/create",
    objective: "Create a fixture workproduct.",
    state,
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/profiles/default-repo",
      sourcePath: "/profiles/default-repo/profiles/default",
      localHead: "abc123",
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "fixture-user", kind: "user", label: "Fixture User" },
    scope: {
      profileId: "default",
      conversationId: "session_1",
      originTurnId: "turn_1",
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      signalRefs: [],
      evalRefs: [],
      targetRepoAssumptions: [],
    },
    target,
    workflowCapture: null,
    executionPolicy: { mode: "background", pauseAllowed: true, cancellationAllowed: true },
    iterationPolicy: { mode: "single", maximumAttempts: 1, currentAttempt: 0 },
    approvalIds: plan?.approvalId ? [plan.approvalId] : [],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [],
    externalExecutionRefs: [],
    localProfileCommit: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: state === "blocked" ? "Fixture run is blocked." : null,
    appliedActionIds: [],
    metadata: {},
    createdAt: CREATE_IMPROVE_FIXTURE_TIMESTAMP,
    updatedAt: CREATE_IMPROVE_FIXTURE_TIMESTAMP,
    ...overrides,
    plan,
  });
}
