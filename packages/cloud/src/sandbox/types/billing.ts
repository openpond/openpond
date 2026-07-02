import type {
  SandboxPreviewAccess,
  SandboxPreviewAuthPolicy,
  SandboxPreviewCorsPolicy,
  SandboxPreviewHeaderPolicy,
  SandboxResources,
  SandboxState,
} from "./index.js";
export type SandboxPricingRate = {
  key: "cpu" | "memory" | "disk" | "durable_volume_storage";
  label: string;
  unit: string;
  unitPriceUsd: string;
  unitPriceHourlyUsd: string;
  unitPriceMonthlyUsd: string | null;
};

export type SandboxPublicResourceTierKey =
  | "tiny"
  | "small"
  | "default"
  | "builder"
  | "heavy-builder";

export type SandboxKeepRunningEstimateLineItem = {
  label: string;
  quantity: number;
  unit: string;
  hourlyUsd: string;
  monthlyUsd: string;
};

export type SandboxKeepRunningEstimate = {
  resources: SandboxResources;
  matchedTierKey: SandboxPublicResourceTierKey | null;
  hourlyUsd: string;
  monthlyUsd: string;
  durationDays: number;
  pricingSource: "openpond_poc_config";
  lineItems: SandboxKeepRunningEstimateLineItem[];
};

export type SandboxPublicResourceTier = {
  key: SandboxPublicResourceTierKey;
  label: string;
  description: string;
  resources: SandboxResources;
  goodFit: string[];
  poorFit: string[];
  keepRunningEstimate: SandboxKeepRunningEstimate;
};

export type SandboxPricingRateCard = {
  currency: "USD";
  source: "openpond_poc_config";
  effectiveAt: string;
  rates: SandboxPricingRate[];
  tiers: SandboxPublicResourceTier[];
};

export type SandboxCostLineItemSummary = {
  label: string;
  unit: string;
  quantity: number;
  amountUsd: string;
};

export type SandboxCostSandboxSummary = {
  sandboxId: string;
  state: SandboxState;
  repo: string | null;
  createdAt: string;
  updatedAt: string;
  receiptCount: number;
  totalUsd: string;
  durationSeconds: number;
  latestReceiptRef: string | null;
  latestReceiptAt: string | null;
};

export type SandboxCostSummary = {
  teamId: string;
  ownerUserId: string;
  pricing: SandboxPricingRateCard;
  summary: {
    sandboxCount: number;
    runningCount: number;
    stoppedCount: number;
    archivedCount: number;
    receiptCount: number;
    totalUsd: string;
    totalDurationSeconds: number;
    activeReservedUsd: string;
    activeRemainingBudgetUsd: string;
    activeRunnerSlots: number;
  };
  lineItems: SandboxCostLineItemSummary[];
  sandboxes: SandboxCostSandboxSummary[];
  recentReceipts: SandboxReceipt[];
  generatedAt: string;
};

export type SandboxBillingStatus = {
  sandboxId: string;
  state: SandboxState;
  billingModel: "reserve_capture" | "session";
  reservationStatus: SandboxReservation["status"];
  budgetUsd: string;
  reservedUsd: string;
  capturedUsd: string;
  remainingBudgetUsd: string;
  mppMode: NonNullable<SandboxReservation["mpp"]>["mode"] | null;
  sessionRef: string | null;
  channelId: string | null;
  depositUsd: string | null;
  acceptedCumulativeUsd: string | null;
  remainingSessionUsd: string | null;
  tickCount: number;
  lastTickAt: string | null;
  finalizedAt: string | null;
  lastReceiptRef: string | null;
  keepRunningEstimate?: SandboxKeepRunningEstimate;
};

export type SandboxReservation = {
  id: string;
  status: "reserved" | "captured" | "released";
  reservedUsd: string;
  capturedUsd: string;
  mpp?: {
    mode: "simulated_poc" | "mpp_service_hook" | "mpp_session_hook";
    settlementRail: "tempo_usdce";
    reservationRef: string;
    sessionRef?: string | null;
    channelId?: string | null;
    depositUsd?: string | null;
    acceptedCumulativeUsd?: string | null;
    remainingUsd?: string | null;
    tickCount?: number;
    lastTickAt?: string | null;
    finalizedAt?: string | null;
    lastReceiptRef?: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type SandboxReceiptLineItem = {
  label: string;
  quantity: number;
  unit: string;
  unitPriceUsd: string;
  amountUsd: string;
};

export type SandboxReceipt = {
  id: string;
  sandboxId: string;
  reservationId: string;
  status: "captured" | "released";
  reason:
    | "stopped"
    | "deleted"
    | "archived"
    | "budget_exhausted"
    | "duration_exceeded"
    | "idle_timeout"
    | "manual_capture";
  totalUsd: string;
  durationSeconds: number;
  lineItems: SandboxReceiptLineItem[];
  mpp: {
    mode: "simulated_poc" | "mpp_service_hook" | "mpp_session_hook";
    settlementRail: "tempo_usdce";
    receiptRef: string;
    sessionRef?: string | null;
    channelId?: string | null;
    acceptedCumulativeUsd?: string | null;
    depositUsd?: string | null;
    remainingUsd?: string | null;
  };
  createdAt: string;
};

export type SandboxCommand = {
  id: string;
  command: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
};

export type SandboxPreviewPort = {
  id: string;
  port: number;
  label: string | null;
  url: string;
  targetUrl?: string | null;
  customDomain?: string | null;
  access: SandboxPreviewAccess;
  autoStart?: boolean;
  cors?: SandboxPreviewCorsPolicy;
  headerPolicy?: SandboxPreviewHeaderPolicy;
  authPolicy?: SandboxPreviewAuthPolicy;
  token: string;
  createdAt: string;
};
