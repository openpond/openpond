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
  billingModel: "reserve_capture" | "session" | "actual_usage";
  computeUsage?: SandboxComputeUsageStatus;
  nativeRootStorage?: SandboxNativeRootStorageStatus;
  snapshotRetention?: SandboxSnapshotRetentionStatus[];
  snapshotRetentionOffer?: SandboxSnapshotRetentionOffer;
  reservationStatus: SandboxReservation["status"];
  budgetUsd: string | null;
  reservedUsd: string;
  capturedUsd: string;
  remainingBudgetUsd: string | null;
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
  usageFunding?: SandboxUsageFundingRef;
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

export type SandboxUsageFundingRef = {
  schemaVersion: "openpond.sandboxUsageFundingRef.v1";
  capacityLeaseId: string;
  authorizationHash: string;
  profileHash: string;
};

export type SandboxComputeUsageSummary = {
  schemaVersion: "openpond.sandboxComputeUsageSummary.v1";
  fundingReservationId: string;
  capacityLeaseId: string;
  authorizationHash: string;
  closureEvidenceHash: string;
  price: { version: string; profileHash: string; currency: "USD"; unit: "resource_hour"; hourlyUsd: string };
  observedQuantityMillis: number;
  billableQuantityMillis: number;
  ratedUsd: string;
  chargedUsd: string;
  includedStandardUsd: string;
  prepaidStandardUsd: string;
  prepaidPayableUsd: string;
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
    | "create_failed"
    | "budget_exhausted"
    | "duration_exceeded"
    | "idle_timeout"
    | "manual_capture";
  totalUsd: string;
  retailTotalUsd?: string;
  durationSeconds: number;
  lineItems: SandboxReceiptLineItem[];
  mpp: {
    mode: "simulated_poc" | "mpp_service_hook" | "mpp_session_hook" | "account_usage";
    settlementRail: "tempo_usdce" | "stripe_credit";
    receiptRef: string;
    sessionRef?: string | null;
    channelId?: string | null;
    acceptedCumulativeUsd?: string | null;
    depositUsd?: string | null;
    remainingUsd?: string | null;
  };
  fundingAllocation?: {
    includedStandardUsd: string;
    prepaidStandardUsd: string;
    postpaidStandardUsd: string;
    customerFundedStandardUsd: string;
    unfundedStandardUsd: string;
  };
  usageSummary?: SandboxComputeUsageSummary;
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

/** Current original actual-use funding; customer retail amounts only. */
export interface SandboxComputeUsageStatus {
  state: "active" | "exhausted" | "closed";
  stopReason: "credit_exhausted" | "cap_reached" | "control_expired" | "policy_changed" | "member_cap_reached" | null;
  customerCapUsd: string | null;
  price: { version: string; currency: "USD"; unit: "resource_hour"; hourlyUsd: string };
  observedQuantityMillis: number;
  billableQuantityMillis: number;
  ratedUsd: string;
  chargedUsd: string;
  includedStandardUsd: string;
  prepaidStandardUsd: string;
  prepaidPayableUsd: string;
  observedAt: string;
  closedAt: string | null;
}

/** Retained native root storage is independent of active compute. */
export interface SandboxNativeRootStorageStatus {
  phase: "executing" | "retained" | "deleted";
  phaseAt: string;
  diskGiB: number;
  price: { version: string; currency: "USD"; unit: "GiB-second"; unitPriceUsd: string };
  quantityGiBMillis: number;
  ratedUsd: string;
  chargedUsd: string;
  includedStandardUsd: string;
  prepaidStandardUsd: string;
  prepaidPayableUsd: string;
  meteredTo: string;
  status: "current" | "funding_shortfall";
  shortfallReason: "credit_exhausted" | "member_cap_reached" | "billing_suspended" | null;
}

/** Finite reserved-source-disk retail; captured snapshot byte size is unknown. */
export type SandboxSnapshotRetentionStatus = {
  snapshotId: string;
  phase: "reserved" | "capture_submitted" | "ready" | "deleting" | "deleted" | "cancelled";
  termsSha256: string;
  reservedDiskGiB: number;
  ttlSeconds: number;
  expiresAt: string;
  maximumUsd: string;
  quotedUsd: string;
  price: { version: string; currency: "USD"; unit: "GiB-second"; unitPriceUsd: string };
  quantityGiBMillis: number;
  ratedUsd: string;
  chargedUsd: string;
  includedStandardUsd: string;
  prepaidStandardUsd: string;
  prepaidPayableUsd: string;
  heldIncludedStandardUsd: string;
  heldPrepaidPayableUsd: string;
  releasedUnusedStandardUsd: string | null;
  meteredTo: string;
  closedAt: string | null;
  status: "current" | "funding_shortfall" | "external_settlement" | "internal_tracked";
  shortfallReason: "credit_exhausted" | "member_cap_reached" | "billing_suspended" | null;
};

export type SandboxSnapshotRetentionQuoteInput = {
  snapshotRetentionTtlSeconds: number;
  snapshotRetentionClass: "ephemeral" | "cached" | "pinned";
};

/** Discovery/quote only; creates no reservation or execution authority. */
export type SandboxSnapshotRetentionOffer =
  | {
      available: false;
      reason:
        | "unsupported_source"
        | "source_unavailable"
        | "billing_unavailable"
        | "terms_unavailable"
        | "retention_out_of_range";
    }
  | {
      available: true;
      termsSha256: string;
      price: SandboxSnapshotRetentionStatus["price"];
      reservedDiskGiB: number;
      maximumTtlSeconds: number;
      maximumCustomerUsd: string;
      quote: null | {
        retentionClass: "ephemeral" | "cached" | "pinned";
        ttlSeconds: number;
        quotedUsd: string;
      };
    };
