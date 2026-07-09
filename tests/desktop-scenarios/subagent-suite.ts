import blockedApproval from "./subagent-blocked-approval";
import boundedWorkerContract from "./subagent-bounded-worker-contract";
import goalScopedDetails from "./goal-scoped-subagent-details";
import heartbeatNoProgressWake from "./subagent-heartbeat-no-progress-wake";
import heartbeatSettings from "./subagent-heartbeat-settings";
import heartbeatStale from "./subagent-heartbeat-stale";
import heartbeatThreadScoped from "./subagent-heartbeat-thread-scoped";
import handoffParentWake from "./subagent-handoff-parent-wake";
import reviewRevisionLoop from "./subagent-review-revision-loop";
import runningState from "./subagent-running-state";
import watchSubmissionWake from "./subagent-watch-submission-wake";
import visibleLifecycle from "./subagent-visible-lifecycle";

export default [
  heartbeatSettings,
  heartbeatNoProgressWake,
  heartbeatThreadScoped,
  heartbeatStale,
  visibleLifecycle,
  runningState,
  handoffParentWake,
  watchSubmissionWake,
  reviewRevisionLoop,
  boundedWorkerContract,
  blockedApproval,
  goalScopedDetails,
];
