# Add tasks to a Dataset

Task submission uses an authenticated OpenPond API, separate from OpenTelemetry.
A successful receipt means a structured task was durably saved and is available
through the ordinary Dataset Tasks reader. It does not start training, publish
a release, create a Model or enable a collection schedule.

Create or choose an editable Dataset in Console and copy its ID. Configure the
server-side SDK with the workspace that owns it:

```ts
import { createOpenPondClient } from "openpond-sdk";

const client = createOpenPondClient({
  apiKey: process.env.OPENPOND_API_KEY!,
  teamId: process.env.OPENPOND_TEAM_ID!,
});

const receipt = await client.addTask(process.env.OPENPOND_DATASET_ID!, {
  name: "Handle an expired API token",
  input: { request: "Fetch the report", observedError: "Token expired" },
  source: { kind: "production_agent", eventId: "run-123" },
}, { idempotencyKey: "run-123" });

console.log(receipt.taskId, receipt.receivedAt);
```

Use a configured `baseUrl` when targeting a different OpenPond API origin.
Never expose the API key in browser code or logged task content.

## Bind the destination once

```ts
import { createTaskAdder } from "openpond-sdk";

const addTask = createTaskAdder({
  apiKey: process.env.OPENPOND_API_KEY!,
  teamId: process.env.OPENPOND_TEAM_ID!,
  datasetId: process.env.OPENPOND_DATASET_ID!,
  baseUrl: "https://api.openpond.ai",
});

await addTask({
  name: "Explain a failed agent run",
  input: { request: "Summarize the report", outcome: "incomplete" },
}, { idempotencyKey: "agent-run-456" });
```

The Dataset ID is still included in every request. The helper binds it locally;
it never uses a global account, last-selected Dataset or implicit Fix-it Model.

## Input and receipt

Every task has a readable `name` and structured `input`. Optional fields are
`expectedOutput`, `split`, `tags` and `source` (`kind`, `eventId`, `label`,
`occurredAt`). The default split is `validation`. A `train` split alone does
not authorize training. Keep a missing correct answer absent rather than
replacing it with an error message.

The complete request is bounded to 128 KiB. The receipt includes workspace,
Dataset, task and operation identities, server `receivedAt`, saved revision,
`state: "saved"` and `trainingUseAuthorized: false`. Source occurrence time is
different from server upload time.

## Delivery and retries

Retain an explicit stable idempotency key for each source event. Repeating the
same key and task in the same authorized destination returns the original
receipt without inserting a duplicate. Reusing a key with different content is
a conflict. Separate keys add separate tasks, including simultaneous writers.

The SDK makes one request; it does not silently replay arbitrary mutations.
When a response is lost, `DatasetTaskIngestionError.operationId` retains the
operation identity and `outcomeUnknown` indicates that persistence could not be
confirmed. Retry the original task with that same key. Do not generate a new
key merely because the response was interrupted. A supplied abort signal is
forwarded to the request; an interrupted response can still have been saved.

```ts
import { DatasetTaskIngestionError } from "openpond-sdk";

try {
  await addTask(task, { idempotencyKey: sourceEventId });
} catch (error) {
  if (error instanceof DatasetTaskIngestionError && error.outcomeUnknown) {
    // Retain task + error.operationId privately for a later exact retry.
  }
  throw error;
}
```

The underlying route is `POST /v1/dataset-workspaces/{datasetId}/tasks`, with
`Authorization: Bearer …`, `X-OpenPond-Team-Id` and JSON:

```json
{
  "schemaVersion": "openpond.datasetTaskAppend.v1",
  "operationId": "stable-source-event",
  "task": {
    "name": "Handle an expired API token",
    "input": { "observedError": "Token expired" }
  }
}
```

The server owns authorization, atomic append and revision history. Appending
does not rewrite fixed Experiment Dataset versions or previously published
releases. Full authoring still uses the revisioned Dataset workspace API.

## Python

The maintained `ponder-sdk` package exposes the same operation on `Client`
and `AsyncClient`:

```python
from ponder_sdk import Client

with Client(base_url=api_origin, api_key=api_key, team_id=team_id) as client:
    receipt = client.add_task(
        dataset_id,
        {"name": "Handle an expired API token", "input": {"error": "Token expired"}},
        idempotency_key=source_event_id,
    )
```

Use `async with AsyncClient(...)` and `await client.add_task(...)` for async
applications. Both use the existing client connection pool and typed wire
validation. Retain the caller's key/task across an unknown mutation outcome.

## OpenTelemetry

OpenTelemetry is an optional source adapter, not this HTTP request format.
Its span exporter can project explicitly selected spans into structured tasks
using the same destination and receipts. It does not make this endpoint an
OTLP receiver, automatically capture arbitrary logs, or authorize training.
