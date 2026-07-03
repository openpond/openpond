import { normalizeOpenPondGoalStatus, type OpenPondGoalStatus } from "@openpond/contracts";

export type OpenPondGoalStatusTone = "active" | "paused" | "done" | "limited";

export type OpenPondGoalStatusPresentation = {
  status: OpenPondGoalStatus | null;
  tone: OpenPondGoalStatusTone;
  actionLabel: string;
};

const OPENPOND_GOAL_STATUS_PRESENTATION: Record<
  OpenPondGoalStatus,
  Omit<OpenPondGoalStatusPresentation, "status">
> = {
  queued: {
    tone: "active",
    actionLabel: "Goal queued",
  },
  running: {
    tone: "active",
    actionLabel: "Pursuing goal",
  },
  awaiting_user_input: {
    tone: "active",
    actionLabel: "Goal awaiting input",
  },
  awaiting_approval: {
    tone: "active",
    actionLabel: "Goal awaiting approval",
  },
  paused: {
    tone: "paused",
    actionLabel: "Goal paused",
  },
  blocked: {
    tone: "limited",
    actionLabel: "Goal blocked",
  },
  completed: {
    tone: "done",
    actionLabel: "Goal achieved",
  },
  failed: {
    tone: "limited",
    actionLabel: "Goal failed",
  },
  cancelled: {
    tone: "limited",
    actionLabel: "Goal cancelled",
  },
  budget_limited: {
    tone: "limited",
    actionLabel: "Goal budget limited",
  },
};

export function openPondGoalStatusPresentation(
  value: string | null | undefined,
): OpenPondGoalStatusPresentation {
  const status = normalizeOpenPondGoalStatus(value);
  if (!status) {
    return {
      status: null,
      tone: "active",
      actionLabel: "Goal status unknown",
    };
  }
  return {
    status,
    ...OPENPOND_GOAL_STATUS_PRESENTATION[status],
  };
}
