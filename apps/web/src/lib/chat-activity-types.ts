export type ActivityItem = {
  id: string;
  label: string;
  content: string;
  timestamp: string;
  kind?: "command" | "control" | "reasoning";
  action?: string;
  controlKind?: "goal_context" | "turn_aborted";
  callId?: string;
  backgroundTaskId?: string;
  startedAgent?: string;
  startedAgentProvider?: string;
  plan?: Array<{ id?: string; content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }>;
  detail?: string;
  terminal?: {
    exitCode?: number | null;
    durationMs?: number;
  };
  meta?: string;
  receipt?: {
    id: string;
    status: string;
    totalUsd: string;
  };
  openSession?: {
    sessionId: string;
    label: string;
    roleId?: string;
    status?: string;
  };
  subagentMessage?: {
    direction: "received" | "sent";
    summary: string;
    body: string;
    messageId: string;
    kind: string;
    fromRunId: string;
    toRunId?: string | null;
    toRole?: string | null;
    childSessionId?: string | null;
    roleId?: string | null;
    modelRef?: {
      providerId: string;
      modelId: string;
    } | null;
    deliveryStatus?: string | null;
    wakeReason?: string | null;
    createdAt?: string | null;
    refs?: Array<{
      kind: string;
      id: string;
      label: string;
    }>;
  };
  state?: "running" | "completed" | "failed" | "pending";
  imagePreview?: {
    path: string;
    appId: string | null;
    title: string;
  };
  artifacts?: Array<{
    path: string;
    title: string;
    contentType: string;
    sizeBytes: number | null;
  }>;
};
