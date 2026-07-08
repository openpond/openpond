import blockedApproval from "./subagent-blocked-approval";
import goalScopedDetails from "./goal-scoped-subagent-details";
import handoffParentWake from "./subagent-handoff-parent-wake";
import runningState from "./subagent-running-state";
import visibleLifecycle from "./subagent-visible-lifecycle";

export default [
  visibleLifecycle,
  runningState,
  handoffParentWake,
  blockedApproval,
  goalScopedDetails,
];
