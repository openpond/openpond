# Add tasks to a Dataset

The APIs below target the **0.12.25 source candidate**, which is not published
yet. Registry version 0.12.24 does not include configured Dataset/named-model
setup. Use the built candidate package until the coordinated release.


Configure a client once in your product's server module. Submit one structured
source event with `await addTask(task)`:

```ts
import { createOpenPondClient } from "openpond-sdk";

export const openpond = createOpenPondClient({
  apiKey: process.env.OPENPOND_API_KEY!,
  teamId: process.env.OPENPOND_TEAM_ID!,
  datasetId: process.env.OPENPOND_DATASET_ID!,
});

const receipt = await openpond.addTask({
  id: sourceEventId,
  name: "Handle an expired API token",
  input: { request: "Fetch the report", observedError: "Token expired" },
  source: { kind: "production_agent", eventId: sourceEventId },
});
console.log(receipt.taskId, receipt.receivedAt);
```

The client connects to OpenPond automatically and keeps its own credentials;
no mutable global account is used. For an explicit alternate Dataset:

```ts
await openpond.dataset(otherDatasetId).addTask({
  id: sourceEventId,
  name: "Explain a failed agent run",
  input: { request: "Summarize the report", outcome: "incomplete" },
});
```

`addTask(datasetId, task)` and the `createTaskAdder` helper remain available.

## Delivery, identity and retries

A successful receipt confirms durable storage of the task and its processing
obligation. It does not wait for indexing, grading or training. Dataset projection
may lag acknowledgement. Await suspends this async function while the JavaScript
event loop continues handling other work. There is no SDK background queue,
flush command or permanent streaming connection.

`id` identifies the source event within the workspace and Dataset. It is separate
from the server's canonical `receipt.taskId`. Repeating the same source ID and
content returns the original receipt; changed content conflicts instead of
silently overwriting. New credentials still need current authorization for that
exact Dataset. A successful upload grants no training permission.

The SDK sends once. It never automatically replays a mutation. Preserve your
source ID and original content across uncertain outcomes:

```ts
import { DatasetTaskIngestionError } from "openpond-sdk";

const task = { id: sourceEventId, name: "Expired token", input: { error: "expired" } };
try {
  await openpond.addTask(task, { signal: request.signal, timeoutMs: 10_000 });
} catch (error) {
  if (error instanceof DatasetTaskIngestionError && error.outcomeUnknown) {
    // Retain task and error.sourceId privately for a later exact retry.
  }
  throw error;
}
```

When `id` is omitted the SDK generates one before dispatch. On uncertain delivery,
`DatasetTaskIngestionError.sourceId` (also `operationId`) retains it. Supply that
ID in a later retry. Prefer an explicit ID when cancellation or process exit could
prevent handling the error. An event never transmitted successfully cannot be
promised durable. `idempotencyKey` is accepted for existing callers; supplying a
conflicting `task.id` is rejected before dispatch.

Every task has `name` and structured `input`. Optional fields: `expectedOutput`,
`split`, `tags`, and `source` (`kind`, `eventId`, `label`, `occurredAt`). Default
split: `validation`; `train` alone grants no learning authority. Requests are
bounded to 128 KiB. The receipt retains workspace, Dataset, canonical task and
source identities, first-save `receivedAt`, revision, `state: "saved"` and
`trainingUseAuthorized: false`. Source occurrence time differs from upload time.
Existing immutable releases and Experiment inputs retain their own identities.

## Python

`ponder-sdk` uses the same configured destination and source ID with its native
owned connection pool:

```python
from ponder_sdk import Client

with Client(api_key=api_key, team_id=team_id,
            dataset_id=dataset_id) as openpond:
    receipt = openpond.add_task({
        "id": source_event_id,
        "name": "Expired token",
        "input": {"error": "Token expired"},
    })
    # Alternate destination; uses the same pool:
    # openpond.dataset(other_dataset_id).add_task(task)
```

Sync calls block their calling thread. Async applications use
`async with AsyncClient(...)` and `await openpond.add_task(task)`. Both validate the
maintained wire schemas and never replay writes automatically. A `PonderError`
retains `operation_id` and `outcome_unknown`; cancellation propagates, so retain
your own source ID before awaiting. Closing the HTTP pool is resource cleanup,
not delivery flushing.

## HTTP and React

The HTTP operation remains `POST /v1/dataset-workspaces/{datasetId}/tasks` with
Bearer auth and `X-OpenPond-Team-Id`. The public `task.id` maps to wire
`operationId`; it is excluded from `task` content:

```json
{
  "schemaVersion": "openpond.datasetTaskAppend.v1",
  "operationId": "stable-source-event",
  "task": { "name": "Expired token", "input": { "error": "expired" } }
}
```

React calls your authenticated product backend. The backend selects an authorized
Dataset and awaits the configured client. Keep OpenPond secrets and destination
authority server-side; do not accept an arbitrary browser-supplied Dataset ID.
For named model calls and the optional Vercel integration see
[product integration](PRODUCT_INTEGRATION.md).

OpenTelemetry is a separate optional source adapter, not this request format.
Project explicitly selected spans into structured tasks. This endpoint is not an
OTLP receiver and does not capture arbitrary logs or authorize training.
