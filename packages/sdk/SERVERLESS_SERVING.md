# Saved Model serving

Read `training.modelServing(modelProjectId, { teamId, versionHash })` for the
exact saved version. Create an approval from its `serverlessReview` with
`createServerlessServingApproval` from `openpond-sdk/training`, then include it
in `training.controlModelServing`. Retain the original operation ID and exact
request.

Read status to follow waiting, starting, running and stopping. Stop requests
cancellation of the original work; status remains readable while stopping.

The signed review's `workerIdleTimeoutSeconds` sets the billable idle reuse
window. Current v3 reviews support 5 or 60 seconds; new reviews use 60 seconds
before unused capacity scales to zero. The activation request must use the
reviewed value. Historical v1/v2 reviews retain their signed 5-second setting.
For v3, `idleBillable: true` includes this reuse window in accepted usage.

## Pending inference and recovery

A queued serving POST returns HTTP 202 with an
`openpond.modelRequestStatus.v1` receipt. The SDK observes that original request
with GET requests until its retained result or bounded observer deadline. It
never resubmits the paid POST. The default observer is 630 seconds;
`serving.timeoutMs` can shorten it. A queued `stream()` call emits the retained
completed text and finish event when available.

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
answers expire after the service's finite retention period. Recovery never
resubmits the original request.

Python uses the same generated serving contracts and
`create_serverless_serving_approval` from `ponder_sdk.serverless_serving`.
Named model calls accept `client_request_id` and a serving-only `timeout`
(default and maximum 630 seconds). Use `recover`, `inspect_request` and
`cancel_request` on the same handle, awaiting them on `AsyncClient`.
`ModelRequestError.client_request_id` retains the original operation identity.
The official hosted Model-serving CLI operations use these same contracts.
