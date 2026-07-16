# Integration Heavy Agent Example

This example proves the setup-heavy path for source-backed agents.

It declares:

- OpenPond Chat and Slack channel adapters
- required Slack and model gateway integrations
- required env/secret setup for `OPENAI_API_KEY`
- a project-scoped `select-or-create` volume
- a disabled weekday schedule
- an output artifact and eval gate
- an editable policy for Builder Chat/source edits

The example intentionally stores setup requirements in source and stores no connection ids, tokens, cookies, or secret values.

## Setup Slots

- Slack is required for the Slack channel.
- OpenPond model gateway access is required through `opchat`.
- GitHub is optional and demonstrates non-blocking integration setup.
- `OPENAI_API_KEY` is a required secret reference; the value belongs in OpenPond secret storage.
- `project-state` is a project-scoped `select-or-create` volume.
- `weekday-summary` is declared but disabled by default.

## Local Commands

```bash
pnpm agent:inspect
pnpm agent:build
pnpm agent:validate
pnpm agent:eval
openpond-agent run chat --input '{"prompt":"Project is blocked on review","channel":"openpond_chat"}'
```

Generated outputs:

- `.openpond/agent-inspect.json`
- `.openpond/agent-manifest.json`
- `.openpond/action-registry.json`
- `.openpond/artifact-index.json`
- `.openpond/eval-results.json`
- `.openpond/traces/*.jsonl`

This pilot proves the setup-heavy path: channel adapters, required and optional integrations, env/secret setup slots, volume selection/provisioning policy, disabled schedules, artifacts, evals, traces, and editable policy.
