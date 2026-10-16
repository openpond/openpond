import type { ChatMessage } from "./app-models";
import type { ChatTimelineMessageRow } from "./chat-timeline-rows";

/** Restore one ordinary tool disclosure across peer exchanges, until dialogue resumes. */
export function groupActivityRuns(rows: readonly ChatTimelineMessageRow[]): ChatTimelineMessageRow[] {
  const result: ChatTimelineMessageRow[] = [];
  let run: ChatTimelineMessageRow[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1 || !run.some(row => row.message.role === "activity_group")) result.push(...run);
    else {
      const first = run[0]!;
      const groups = run.map(row => row.message).filter(message => message.role === "activity_group");
      const last = groups.at(-1)!;
      const message: ChatMessage = {...first.message, role: "activity_group", content: undefined,
        taskMessage: undefined, taskMessagePresentation: undefined, refinerActivity: groups.slice().reverse().find(message => message.refinerActivity)?.refinerActivity, activityMessages: run.map(row => row.message),
        activities: groups.flatMap(message => message.activities ?? []),
        traceStartedAt: groups[0]?.traceStartedAt,
        traceCompletedAt: last.traceCompletedAt,
        traceState: groups.some(message => message.traceState === "failed") ? "failed" :
          groups.some(message => message.traceState === "running") ? "running" : last.traceState,
      };
      result.push({...first, message, showFooter: false});
    }
    run = [];
  };
  for (const row of rows) {
    const message = row.message;
    const ordinaryActivity = message.role === "activity_group" && !message.deliverables?.length
      && !message.userQuestion;
    if (ordinaryActivity || message.role === "task_message") run.push(row);
    else { flush(); result.push(row); }
  }
  flush();
  return result;
}
