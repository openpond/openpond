export type PlanUsageProvider = "claude-code" | "codex";

export type PlanUsageWindow = {
  id: string;
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  /** Only shared plan windows contribute to the compact summary. */
  shared: boolean;
};

export type ProviderPlanUsage = {
  provider: PlanUsageProvider;
  status: "ready" | "unavailable" | "signed_out" | "unsupported";
  windows: PlanUsageWindow[];
  fetchedAt: string;
  refreshAfter: string;
  message: string | null;
};
