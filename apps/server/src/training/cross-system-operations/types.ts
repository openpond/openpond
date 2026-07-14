import type { CrossSystemToolName } from "@openpond/contracts";

export type CrossSystemSplit = "train" | "validation" | "frozen_eval";
export type CrossSystemDifficulty = "easy" | "medium" | "hard";
export type CrossSystemTaskFamily =
  | "renewal_exposure"
  | "collections_prioritization"
  | "invoice_reconciliation"
  | "sla_escalation"
  | "contract_billing_mismatch";

export type CrossSystemAccount = {
  accountId: string;
  name: string;
  aliases: string[];
  contactIds: string[];
  contractValueUsdCents: number;
  renewalDate: string;
  tier: "standard" | "growth" | "enterprise" | "strategic";
  activeContractId: string;
  contractTermMonths: number;
  billingCadence: "monthly" | "quarterly" | "annual";
};

export type CrossSystemContact = {
  contactId: string;
  accountId: string;
  name: string;
  email: string | null;
};

export type CrossSystemInvoice = {
  invoiceId: string;
  accountId: string;
  contractId: string;
  issuedDate: string;
  dueDate: string;
  currency: "USD" | "EUR" | "GBP";
  amountCents: number;
  status: "open" | "overdue" | "paid" | "disputed" | "scheduled" | "void";
  descriptor: string;
  billedTermMonths: number;
};

export type CrossSystemPayment = {
  paymentId: string;
  accountId: string | null;
  receivedDate: string;
  currency: "USD" | "EUR" | "GBP";
  amountCents: number;
  descriptor: string;
  matchedInvoiceId: string | null;
};

export type CrossSystemSupportCase = {
  caseId: string;
  accountId: string;
  customerIdentifier: string;
  severity: "P1" | "P2" | "P3" | "P4";
  state: "new" | "investigating" | "waiting_customer" | "resolved" | "closed";
  openedAt: string;
  responseDueAt: string;
  resolutionDueAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  escalationHistory: Array<{ at: string; reason: string }>;
};

export type CrossSystemGroundTruth = {
  queryPlan: Array<{ tool: CrossSystemToolName; purpose: string }>;
  expectedAnswer: Record<string, unknown>;
  entityLineage: Record<string, string[]>;
};

export type CrossSystemWorld = {
  schemaVersion: "openpond.crossSystemOperations.v1";
  generatorVersion: "1.0.0";
  id: string;
  seed: number;
  split: CrossSystemSplit;
  difficulty: CrossSystemDifficulty;
  namespace: string;
  referenceDate: string;
  toolContractHash: string;
  fxUsdMicros: Record<"USD" | "EUR" | "GBP", number>;
  accounts: CrossSystemAccount[];
  contacts: CrossSystemContact[];
  invoices: CrossSystemInvoice[];
  payments: CrossSystemPayment[];
  supportCases: CrossSystemSupportCase[];
  groundTruth: Record<CrossSystemTaskFamily, CrossSystemGroundTruth>;
};

export type CrossSystemTask = {
  schemaVersion: "openpond.crossSystemOperations.v1";
  id: string;
  worldId: string;
  clusterKey: string;
  split: CrossSystemSplit;
  family: CrossSystemTaskFamily;
  difficulty: CrossSystemDifficulty;
  phrasingVariant: number;
  prompt: string;
  expectedAnswer: Record<string, unknown>;
  queryPlan: CrossSystemGroundTruth["queryPlan"];
  toolContractHash: string;
  budget: { maxTurns: 15; maxRows: number; maxBytes: number };
};

export type CrossSystemToolEvidence = {
  schemaVersion: "openpond.crossSystemOperations.v1";
  attemptId: string;
  sequence: number;
  toolContractHash: string;
  tool: CrossSystemToolName;
  arguments: Record<string, unknown>;
  ok: boolean;
  rows: number;
  bytes: number;
  durationMs: number;
  result: unknown;
  error: string | null;
};
