# Usage-based saved Model serving

A saved trained Model can be activated when the service returns a compatible
Serverless price review. Model availability and GPU residency are separate:
the Model stays callable while unused workers scale down. Cold requests can wait
for model loading; no fixed cold-start latency is promised.

Read `training.modelServing(modelProjectId, { teamId, versionHash })` for the
exact saved version. When `serverlessReview` is available, use
`createServerlessServingApproval(serverlessReview, spendingLimit)` from
`openpond-sdk/training` and include the result as `serverlessApproval` in the
normal `training.controlModelServing` activation request. Retain the original
operation ID and exact request for recovery. The request's idle setting must
match the review's `workerIdleTimeoutSeconds`.

Activation creates callable configuration. New `openpond.serverlessServingReview.v2`
terms settle attributable worker runtime from confirmed worker start through full
stop. This includes cold start, model loading, execution, idle time and cleanup,
including failed loading. Queue wait before a worker starts and time scaled down
are not billed. Worker lifetime is rounded up to a whole second once, before
allocation; compatible requests share the same interval rather than each
receiving a full GPU clock. Token usage is still reported with no additional
token charge for the same Serverless request.

Read the exact retained review: historical v1 receipts preserve their original
engine-only terms. They are not retroactively charged under v2. Refresh the price
review before creating a new approval; the SDK does not mint new v1 approvals.

The optional spending limit bounds the accepted activation's cumulative usage.
An omitted limit uses available workspace credit. Pending requests retain their
credit holds until worker stop and settlement are confirmed. Stop closes new admission
and requests cancellation while preserving outstanding settlement and cleanup.
Unconfirmed runtime remains pending with credit reserved until verified. Delayed
records do not change the accepted rate.

Current usage is returned in `control.serverless`: `chargedUsd`, `reservedUsd`,
`quantityMicros` and the retained review. Supplier-cost status is separate from
the customer debit. An unavailable review does not qualify another model or
modification method automatically.

Python consumers use the same generated request/response contracts and can
import `create_serverless_serving_approval` from `ponder_sdk.serverless_serving`.
The official CLI's `hosted-model-serving` and `hosted-control-model-serving`
operations use these same Model contracts.
