/** Paid comparison evaluation remains fail-closed until per-provider-request
 * admission and an authoritative retail quote are wired. A run-level
 * maximumSpendUsd does not bound tool loops or compaction. This qualification
 * requirement applies to every Profile, not a hard-coded customer identity. */
export function assertRfqEvaluationPaidDispatchQualified(): void {
  throw new Error(
    "Paid comparison evaluation is blocked: aggregate budget admission is not wired to every model request, " +
    "and provider-enforced input/output ceilings plus an immutable retail quote are unproven.",
  );
}
