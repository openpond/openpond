export type DeterministicOutputContract = {
  requiredText?: string[];
  requiredAny?: string[][];
  forbiddenText?: string[];
  maxWords?: number;
  minLinks?: number;
  requireMessageBody?: boolean;
};

const CONTRACTS: Readonly<Record<string, DeterministicOutputContract>> = {
  "adaptation-board-launch-brief": {},
  "adaptation-latency-incident-review": {},
  "adaptation-program-budget-workbook": {},
  "adaptation-invoice-correction-email": {
    requiredText: ["inv-1842", "120", "102", "august 14", "accounts@example.com"],
    requiredAny: [["no payment", "not due"]],
    forbiddenText: ["intentional error", "deliberate error"],
    maxWords: 130,
    requireMessageBody: true,
  },
  "adaptation-nextjs-security-audit": {
    requiredAny: [
      ["affected"],
      ["fixed", "patched"],
      ["checked", "as of"],
      ["version and configuration", "version or configuration", "exact version"],
    ],
    minLinks: 1,
  },
  "adaptation-workshop-reschedule-email": {
    requiredText: ["september 10", "2:00", "et", "recording", "events@example.com"],
    requiredAny: [["facilitator", "presenter"], ["registration", "registrations"]],
    forbiddenText: ["venue caused", "venue's fault"],
    maxWords: 120,
    requireMessageBody: true,
  },
  "adaptation-accessible-boston-dc-plan": {
    requiredText: ["september 17", "september 19"],
    requiredAny: [
      ["wheelchair", "accessible", "accessibility"],
      ["outbound"],
      ["return"],
      ["disruption", "service alert"],
      ["checked", "as of"],
      ["confirm", "confirmation"],
    ],
    minLinks: 1,
  },
  "adaptation-chatgpt-public-experiences": {
    requiredAny: [
      ["positive"],
      ["negative"],
      ["anecdote", "anecdotal"],
      ["pattern", "recurring"],
      ["sampling", "sample"],
      ["limitation", "access"],
    ],
    minLinks: 1,
  },
  "adaptation-launch-delay-email": {
    requiredText: ["august 27", "august 22", "pilot-support@example.com"],
    requiredAny: [["accessibility testing", "accessibility test"], ["pilot access"]],
    forbiddenText: ["testing failed", "test failed", "compensation"],
    maxWords: 140,
    requireMessageBody: true,
  },
  "adaptation-service-window-email": {
    requiredText: ["august 18", "1:00", "2:00", "utc", "status.example.com"],
    requiredAny: [["read-only", "read only"], ["alerts"], ["no data loss"]],
    forbiddenText: ["zero interruption", "no interruption"],
    maxWords: 125,
    requireMessageBody: true,
  },
  "frozen-clinic-relocation-brief": {},
  "frozen-payment-incident-review": {},
  "frozen-grant-budget-workbook": {},
  "frozen-shipping-delay-chat-message": {
    requiredText: ["august 21", "august 22", "morgan", "logistics"],
    requiredAny: [["transfer window"], ["installation", "crew"]],
    forbiddenText: ["equipment is lost", "shipment is lost"],
    maxWords: 90,
    requireMessageBody: true,
  },
  "frozen-python-requests-security-audit": {
    requiredAny: [
      ["affected"],
      ["fixed", "patched"],
      ["checked", "as of"],
      ["dependency graph", "exact dependency", "usage"],
    ],
    minLinks: 1,
  },
  "frozen-refund-support-reply": {
    requiredText: ["$48", "august 16", "five business days", "cb-7714"],
    requiredAny: [["original payment method"], ["duplicate", "charge"]],
    forbiddenText: ["refund is approved", "refund has been approved"],
    maxWords: 110,
    requireMessageBody: true,
  },
  "frozen-accessible-chicago-stl-plan": {
    requiredText: ["october 8", "october 10"],
    requiredAny: [
      ["wheelchair", "accessible", "accessibility"],
      ["outbound"],
      ["return"],
      ["disruption", "service alert"],
      ["checked", "as of"],
      ["confirm", "confirmation"],
    ],
    minLinks: 1,
  },
  "frozen-new-jersey-youth-grants": {
    requiredAny: [
      ["new jersey", "nj"],
      ["eligibility", "eligible"],
      ["deadline", "due"],
      ["checked", "as of"],
    ],
    minLinks: 1,
  },
  "frozen-maintenance-followup-email": {
    requiredText: ["july 28", "august 1", "security", "two business days"],
    requiredAny: [["repair date", "repair schedule"]],
    forbiddenText: ["sue", "lawsuit", "legal action"],
    maxWords: 130,
    requireMessageBody: true,
  },
  "frozen-vendor-document-followup-email": {
    requiredText: ["insurance certificate", "august 7", "rosa", "august 12"],
    requiredAny: [["onboarding", "cannot finish", "blocked"]],
    forbiddenText: ["cancel the contract", "contract cancellation"],
    maxWords: 120,
    requireMessageBody: true,
  },
};

export function deterministicContractFor(
  taskId: string,
): DeterministicOutputContract {
  const contract = CONTRACTS[taskId];
  if (!contract) throw new Error(`Missing deterministic contract for ${taskId}.`);
  return contract;
}

export function deterministicContractTaskIds(): string[] {
  return Object.keys(CONTRACTS).sort();
}
