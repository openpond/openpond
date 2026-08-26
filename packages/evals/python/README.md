# `openpond-evals`

Python producer SDK for the portable OpenPond evaluation and training telemetry
contracts. It is maintained beside `@openpond/evals` and uses the same schema
literals and conformance fixtures.

```python
from datetime import datetime, timezone
from openpond_evals import TelemetryBuilder

builder = TelemetryBuilder(lineage)
event = builder.event(
    occurred_at=datetime.now(timezone.utc),
    source="optimizer",
    event_type="optimizer_step_completed",
)
loss = builder.observation(
    metric_id="optimizer.loss",
    event=event,
    value=0.42,
    dimensions={"split": "train"},
)
```

Use `AsyncTelemetryEmitter` around `BufferedTelemetryEmitter` to move network
delivery off the trainer hot path. Closing the asynchronous emitter drains its
queue and performs a terminal flush. Delivery failures are retained and raised
to the caller rather than silently dropping evidence.

This package does not contain trainers, optimizers, RunPod provisioning,
credentials, hosted storage, billing, or diagnostic-agent behavior.
