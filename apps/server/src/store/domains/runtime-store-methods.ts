import type { SqliteDomainContext } from "../store-domain.js";
import { lazyStoreDomain, type StoreDomainLifecycle } from "../store-domain-loader.js";

export function runtimeStoreMethods(context: SqliteDomainContext, lifecycle: StoreDomainLifecycle) {
  const taskInbox = lazyStoreDomain(lifecycle, () => import("../store-task-inbox.js").then(module => new module.SqliteTaskInboxStore(context)));
  const harnessWorkspaces = lazyStoreDomain(lifecycle, () => import("../store-harness-workspaces.js").then(module => new module.SqliteHarnessWorkspaceStore(context)));
  const harnessRefinementCandidates = lazyStoreDomain(lifecycle, () => import("../store-harness-refinement-candidates.js").then(module => new module.SqliteHarnessRefinementCandidateStore(context)));
  const harnessEvaluationReviewSettings = lazyStoreDomain(lifecycle, () => import("../store-harness-evaluation-review-settings.js").then(module => new module.SqliteHarnessEvaluationReviewSettingsStore(context)));
  const harnessMemory = lazyStoreDomain(lifecycle, () => import("../store-harness-memory.js").then(module => new module.SqliteHarnessMemoryStore(context)));
  const sidebarFileBookmarks = lazyStoreDomain(lifecycle, () => import("../store-sidebar-file-bookmarks.js").then(module => new module.SqliteSidebarFileBookmarkStore(context)));
  const workEvidence = lazyStoreDomain(lifecycle, () => import("../store-work-evidence.js").then(module => new module.SqliteWorkEvidenceStore(context)));
  const chatWorkflows = lazyStoreDomain(lifecycle, () => import("../store-chat-workflows.js").then(module => new module.SqliteChatWorkflowStore(context)));
  const conversationServing = lazyStoreDomain(lifecycle, () => import("../store-conversation-serving.js").then(module => new module.SqliteConversationServingStore(context)));
  const schedules = lazyStoreDomain(lifecycle, () => import("../store-schedules.js").then(module => new module.SqliteScheduleStore(context)));
  const subagents = lazyStoreDomain(lifecycle, () => import("../store-subagents.js").then(module => new module.SqliteSubagentStore(context)));
  const usage = lazyStoreDomain(lifecycle, () => import("../store-usage.js").then(module => new module.SqliteUsageStore(context)));
  const sidebarPreferences = lazyStoreDomain(lifecycle, () => import("../store-sidebar-preferences.js").then(module => new module.SqliteSidebarPreferenceStore(context)));
  return {
    ...schedules.methods([
      "listLocalAgentSchedules",
      "listDueLocalAgentSchedules",
      "getLocalAgentSchedule",
      "upsertLocalAgentSchedule",
      "deleteLocalAgentSchedulesNotIn",
      "patchLocalAgentSchedule",
      "insertLocalAgentScheduleRun",
      "getLocalAgentScheduleRun",
      "listLocalAgentScheduleRuns",
      "patchLocalAgentScheduleRun",
    ]),
    ...subagents.methods([
      "getPersistedSubagentRun",
      "upsertPersistedSubagentRun",
      "upsertSubagentRun",
      "recordRetainedWorkspaceExpiryWarning",
      "getSubagentRun",
      "listSubagentRuns",
      "listActiveSubagentRuns",
      "listSubagentRunScopes",
      "listStaleSubagentRuns",
      "appendSubagentMessage",
      "listSubagentMessages",
    ]),
    ...usage.methods([
      "upsertModelUsageRecord",
      "getModelUsageRecordByRequestId",
      "listModelUsageRecords",
      "latestContextUsageForTurn",
    ]),
    ...sidebarPreferences.methods([
      "getSidebarAppPreferences",
      "patchSidebarAppPreference",
      "reorderSidebarApps",
    ]),
    ...taskInbox.methods([
      "recoverTaskInboxOwners",
      "hasTaskCompletion",
      "taskInboxSnapshot",
      "declareTaskWork",
      "taskWorkAreas",
      "admitTaskInput",
      "admitTaskInputs",
      "rejectTaskInput",
      "getTaskInput",
      "taskInputsForSession",
      "mutateTaskInput",
      "openTaskInboxTurn",
      "renewTaskInboxTurn",
      "pendingTaskInputs",
      "taskAssignmentInputs",
      "pauseTaskInboxTurn",
      "includeTaskInputs",
      "settleTaskInputRequest",
      "sealTaskInboxTurn",
      "sealNativeTaskInboxTurn",
      "closeTaskInboxTurn",
      "taskInboxPaused",
      "reserveTaskFollowup",
      "taskInboxWakeTargets",
      "createTaskWait",
      "settleTaskWait",
      "taskWaitsForSession",
      "commitSubagentCompletion",
      "pendingTaskCompletions",
      "settleTaskCompletion",
    ]),
    ...harnessWorkspaces.methods([
      "createHarnessWorkspace",
      "createHarnessWorkspaceWithRelease",
      "getHarnessWorkspace",
      "listHarnessWorkspaces",
      "selectHarnessWorkspace",
      "getSelectedHarnessWorkspace",
      "updateHarnessWorkspaceSourceRevisionAtomically",
      "saveHarnessReleaseRecord",
      "getHarnessReleaseRecord",
      "listHarnessReleaseRecords",
      "saveHarnessImprovementArtifact",
      "listHarnessImprovementArtifacts",
      "listPendingHarnessRefinerTriggers",
      "createHarnessRunOverlay",
      "getHarnessRunOverlay",
      "appendHarnessRunOverlayEditsAtomically",
      "freezeHarnessRunOverlayAtomically",
      "abandonHarnessRunOverlayAtomically",
      "restoreHarnessRunOverlayAtomically",
      "freezeHarnessRunOverlayWithProposalAtomically",
      "advanceHarnessWorkspaceAtomically",
      "rollbackHarnessWorkspaceAtomically",
      "advanceReviewedHarnessWorkspaceAtomically",
      "listHarnessAdvanceReceipts",
    ]),
    ...harnessRefinementCandidates.methods([
      "listHarnessRefinementCandidates",
      "getHarnessRefinementCandidateByFingerprint",
      "saveHarnessRefinementCandidateTransition",
      "saveHarnessCrossRunRefinementRequestIfAbsent",
    ]),
    ...harnessEvaluationReviewSettings.methods([
      "getHarnessBackgroundReviewSettings",
      "setHarnessBackgroundReviewSettings",
      "getHarnessEvaluationReviewSettings",
      "setHarnessEvaluationReviewSettings",
    ]),
    ...harnessMemory.methods([
      "listHarnessMemories",
      "getHarnessMemory",
      "writeHarnessMemory",
    ]),
    ...sidebarFileBookmarks.methods([
      "listSidebarFileBookmarks",
      "patchSidebarFileBookmark",
    ]),
    ...workEvidence.methods([
      "saveWorkEvidenceProjection",
      "getWorkEvidenceProjectionBySourceRevision",
      "getWorkEvidenceProjection",
      "listWorkEvidenceProjections",
      "saveWorkFeedback",
      "getWorkFeedback",
      "listWorkFeedbackForEvidence",
    ]),
    ...chatWorkflows.methods([
      "listChatWorkflows",
      "listDueChatWorkflows",
      "getChatWorkflow",
      "upsertChatWorkflow",
      "patchChatWorkflow",
      "deleteChatWorkflow",
      "insertChatWorkflowRun",
      "listChatWorkflowRuns",
      "patchChatWorkflowRun",
    ]),
    ...conversationServing.methods([
      "listConversationServingGrants",
      "listConversationServingExecutions",
      "saveConversationServingGrant",
      "saveConversationServingExecution",
    ]),
  };
}
