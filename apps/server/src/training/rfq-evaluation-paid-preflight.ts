/** Known private RFQ Profile. This check is deliberately fail-closed until
 * per-provider-request admission and an authoritative retail quote are wired.
 * A run-level maximumSpendUsd does not bound tool loops or compaction. */
const RFQ_PROFILE_ID = "storage-scholars";

export function assertRfqEvaluationPaidDispatchQualified(profileId: string): void {
  if (profileId !== RFQ_PROFILE_ID) return;
  throw new Error(
    "Storage Scholars RFQ paid evaluation is blocked: the $25 aggregate ledger is not wired to every model request, " +
    "and provider-enforced input/output ceilings plus an immutable retail quote are unproven.",
  );
}
