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

Activation creates callable configuration. Each inference reserves a finite
amount of workspace credit before dispatch and settles observed allocated
execution time. Compatible requests can share a worker; their quantities divide
the same interval rather than each receiving a full GPU clock. Startup, queue
and idle time have no separate customer charge. Token usage is still reported,
with no additional token charge for the same Serverless request.

The optional spending limit bounds the accepted activation's cumulative usage.
An omitted limit uses available workspace credit. Pending requests retain their
credit holds until execution release is confirmed. Stop closes new admission
and requests cancellation while preserving outstanding settlement and cleanup.
Delayed supplier records do not increase an accepted customer price.

Current usage is returned in `control.serverless`: `chargedUsd`, `reservedUsd`,
`quantityMicros` and the retained review. Supplier-cost status is separate from
the customer debit. An unavailable review does not qualify another model or
modification method automatically.

Python consumers use the same generated request/response contracts and can
import `create_serverless_serving_approval` from `ponder_sdk.serverless_serving`.
The official CLI's `hosted-model-serving` and `hosted-control-model-serving`
operations use these same Model contracts.
