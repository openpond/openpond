/**
 * Deterministic copies of the audit facts in the repository-level
 * account-health-inputs directory. The checked-in source files remain the
 * evidence of record; these constants keep the generated SDK project portable.
 */

export const fixtureAsOfDate = "2026-07-20";

export const sourceFiles = [
  "accounts.json",
  "product-usage.csv",
  "support-cases.json",
  "billing-status.json",
] as const;

export type AccountId = "acme" | "northstar" | "glacier";

export type AccountHealthRecord = {
  id: AccountId;
  name: string;
  renewalDays: number;
  owner: string | null;
  activeSeatChange: string;
  usageTrend: "declining" | "growing" | "flat";
  seatRequest: number;
  supportPriority: "P1" | "P2" | "P3";
  supportStatus: "open" | "resolved";
  supportOwner: string | null;
  disputedInvoice: boolean;
  overdueDays: number;
};

export const accounts: Record<AccountId, AccountHealthRecord> = {
  acme: {
    id: "acme",
    name: "Acme",
    renewalDays: 21,
    owner: "Revenue Operations",
    activeSeatChange: "-31%",
    usageTrend: "declining",
    seatRequest: 0,
    supportPriority: "P1",
    supportStatus: "open",
    supportOwner: "Support",
    disputedInvoice: true,
    overdueDays: 19,
  },
  northstar: {
    id: "northstar",
    name: "Northstar",
    renewalDays: 87,
    owner: "Account Executive",
    activeSeatChange: "+18%",
    usageTrend: "growing",
    seatRequest: 25,
    supportPriority: "P3",
    supportStatus: "resolved",
    supportOwner: null,
    disputedInvoice: false,
    overdueDays: 0,
  },
  glacier: {
    id: "glacier",
    name: "Glacier",
    renewalDays: 43,
    owner: null,
    activeSeatChange: "0%",
    usageTrend: "flat",
    seatRequest: 0,
    supportPriority: "P2",
    supportStatus: "resolved",
    supportOwner: null,
    disputedInvoice: false,
    overdueDays: 0,
  },
};

export const accountIds = Object.keys(accounts) as AccountId[];

export const requiredAccountSummaries: Record<AccountId, string> = {
  acme:
    "Acme is high risk. Renewal is in 21 days; active seats are down 31%; a disputed invoice is 19 days overdue; and a P1 support case is open. Resolve the billing dispute and P1 first. Owner: Revenue Operations with Support. Sources: accounts.json, product-usage.csv, support-cases.json, billing-status.json.",
  northstar:
    "Northstar is an expansion opportunity. Renewal is in 87 days, active seats are up 18%, there is no overdue balance, and the customer requested 25 additional seats. Owner: Account Executive for expansion follow-up. Sources: accounts.json, product-usage.csv, billing-status.json.",
  glacier:
    "Glacier is medium risk. Renewal is in 43 days, usage is flat, there is no P1 support case, and the account owner is missing. Assign an owner before the weekly review. Sources: accounts.json, product-usage.csv, support-cases.json.",
};

export const approvedSourceContext = {
  objective:
    "Monitor customer account health, answer account questions with source-backed facts, triage renewal risk, and produce a weekly account review with clear owners and next steps.",
  capturedContextSummary: "Lab-authored Agent objective.",
  priorityDecision:
    "Rank overdue or disputed billing and open P1 support blockers before adoption decline.",
  evidenceSnapshotId: "approved-at-runtime",
  evidenceSnapshotHash: "recorded-in-openpond-run-receipt",
  signalRefs: ["three-approved-account-health-chats"],
  tasksetId: "account-health-frozen-taskset",
  tasksetHash: "recorded-in-openpond-taskset-receipt",
} as const;
