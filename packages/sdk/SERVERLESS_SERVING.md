# Usage-based saved Model serving

A saved trained Model can be activated when the service returns a compatible
Serverless price review. The Model remains callable while unused workers scale
down. Cold requests can wait for capacity and model loading; no fixed startup
latency is promised.

Read `training.modelServing(modelProjectId, { teamId, versionHash })` for the
exact saved version. Pass its `serverlessReview` to
`createServerlessServingApproval(review, spendingLimit)` from
`openpond-sdk/training`, then include that approval in the normal
`training.controlModelServing` request. Retain the original operation ID and
exact request. The idle setting must match the review.

New `openpond.serverlessServingReview.v3` terms deduct observed, attributable
worker usage approximately every 15 seconds, with a final partial interval.
Activation and queued requests reserve no future credit. A spending limit caps
the accepted activation's cumulative funded retail usage; it is never charged
upfront. Other existing credit commitments remain respected.

Billable quantity comes from qualified native worker clocks. Loading, execution,
idle and shutdown count while that clock advances, including failed loading.
Queue time and scaled-down time do not count. An initializing status or elapsed
wall time alone does not establish billable startup. Missing quantity evidence
remains pending. The platform uses finite operator underwriting while clocks
are qualified and work stops; that is separate from the customer's balance and
does not imply a guaranteed external shutdown time. Uncollectible usage becomes
operator expense, without overdrawing prepaid credit or silently charging it
after a later top-up.

Compatible requests share each physical interval by billing principal and then
request. Worker lifetime rounding happens once. Tokens remain reported with no
additional token charge for the same Serverless request. Supplier reconciliation
is separate and cannot charge an already consumed interval again.

Historical v1 and v2 operations retain their original accepted terms and cleanup
custody. They do not become v3 operations when a client is updated. Refresh the
review before creating a new approval.

`control.serverless.usage` identifies the periodic mode and reports the phase,
`ratedUsd`, funded retail `chargedUsd`, actual prepaid `prepaidDebitedUsd`,
`includedUsageUsd`, evidence/debit timestamps and pending evidence. `reservedUsd`
is zero for v3. Waiting, starting, running and stopping remain recoverable states.
Stop closes new admission and cancels the exact original work; cleanup remains
observable independently of delayed supplier records.

## Pending inference and recovery

A queued serving POST returns HTTP 202 with an
`openpond.modelRequestStatus.v1` receipt. The SDK observes that original request
with GET requests until its retained result or bounded observer deadline. It
never resubmits the paid POST. The default observer is 630 seconds, including a
short response allowance around the signed queue/request deadline;
`serving.timeoutMs` can shorten it. Increasing the observer does not repair a
worker that cannot start. A queued `stream()` call emits the retained completed
text and finish event when available.

Every SDK call creates a stable `clientRequestId` before POST. You may supply
one explicitly. If observation ends with an unknown outcome, retain both IDs
from `ProductModelError` and recover the original operation:

```ts
try {
  const answer = await model.generate({ prompt: "Explain the result." });
} catch (error) {
  if (error instanceof ProductModelError && error.outcomeUnknown && error.clientRequestId) {
    const status = await model.recover(error.clientRequestId);
    // status.result is present when the original operation has completed.
  }
}
```

`model.inspectRequest(requestId)` reads by canonical request ID;
`model.cancelRequest(requestId)` explicitly requests cancellation. Recovery
checks the original actor, current access and exact model identity. Retained
answers expire after the service's finite retention period; expiry never
releases or repeats a monetary operation.

Python uses the same generated serving contracts and
`create_serverless_serving_approval` from `ponder_sdk.serverless_serving`.
Named model calls accept `client_request_id` and a serving-only `timeout`
(default and maximum 630 seconds). Use `recover`, `inspect_request` and
`cancel_request` on the same handle, awaiting them on `AsyncClient`.
`ModelRequestError.client_request_id` retains the original operation identity.
The official hosted Model-serving CLI operations use these same contracts.
