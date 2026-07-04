# Platform Boundary

The SDK owns source authoring, local inspection, generated runtime artifacts, validation, local action runs, traces, and evals. OpenPond Cloud owns durable platform state and infrastructure operations.

## SDK-Owned

- TypeScript authoring primitives under `agent/`.
- Generated `.openpond` artifacts.
- `openpond-agent inspect --json` projection.
- Local validation issue codes and UI-safe summaries.
- Local trace JSONL and eval result schemas.
- Channel adapter contracts: normalize input and render response.
- Editable policy declaration for source-edit discovery.

## Platform-Owned

- Integration lease selection and OAuth/connection authorization.
- Env/secret storage and secret value redaction outside source.
- Volume selection, provisioning, attachment, and runtime mounting.
- Schedule enablement, scheduler sync, and schedule delivery auth.
- draft source refs, preserved source checkpoints, live source refs, and publish promotion.
- Hosted runtime provisioning, agent binding, and run history.
- Durable conversations, Builder Chat, coding work items, trace/eval artifact refs, and UI projections.

## Boundary Contract

Source can declare what it needs:

```ts
integrations: [defineIntegration({ provider: "slack", required: true })],
env: [secret.env("OPENAI_API_KEY", { required: true })],
volumes: [defineVolume("state", "/workspace/volumes/state", { provisioning })],
schedules: [schedule.cron("daily", { enabledByDefault: false, target })],
editable: editable({ requiredChecks: ["openpond-agent validate", "openpond-agent eval"], ...policy }),
```

Source must not store the selected Slack connection id, raw secret value, provisioned volume id, enabled schedule id, draft source ref, publish transaction id, or run history row. Those are platform setup bindings and runtime records.

## Required Platform Bindings

| Source declaration | Platform binding | Missing binding behavior |
| --- | --- | --- |
| `integrations[]` | selected connection or lease grant | deploy/publish blocked for required slots |
| `env[]` | OpenPond secret ref or env binding | deploy/publish blocked for required slots |
| `volumes[]` | selected or provisioned volume ref | deploy/publish blocked when required |
| `schedules[]` | disabled schedule row, later enabled by user | schedule remains disabled until setup is complete |
| `channels[]` | channel install/bot binding and delivery auth | channel disabled or setup warning |
| `editable.requiredChecks` | source-edit validation commands | edit cannot publish without passing checks |

## Tests

The package tests prove the source side of the boundary. Platform repos must prove the binding side with deploy-plan, setup, publish, and run-path tests.
