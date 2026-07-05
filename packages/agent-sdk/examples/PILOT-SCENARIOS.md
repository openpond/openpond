# Pilot Scenarios

This file is the checked pilot scenario artifact for the source-backed agent system. It records the source tree, generated artifact tree, setup slots, inspect/deploy-plan projection, edit scenario, channel scenario, volume/setup scenario, and migration note for each SDK pilot.

Trace file names include timestamps, so trace artifacts are listed as `.openpond/traces/*.jsonl`.

## Blank Agent

Purpose: minimal raw-agent happy path with no required external setup.

Source tree:

```text
examples/blank-agent/
  README.md
  package.json
  agent/actions.ts
  agent/agent.ts
  agent/channels/openpond-chat.ts
  agent/editable.ts
  agent/evals/basic.eval.ts
  agent/instructions.md
  agent/skills/basic.md
  agent/workflows/chat.ts
```

Generated artifact tree:

```text
examples/blank-agent/.openpond/
  action-registry.json
  agent-inspect.json
  agent-manifest.json
  artifact-index.json
  eval-results.json
  openpond-manifest.preview.yaml
  prompts/instructions.md
  runtime-bridge.mjs
  skills/basic/SKILL.md
  traces/*.jsonl
  validator-report.md
```

Setup slots and inspect/deploy-plan projection:

- Actions: `chat`, `answer`
- Default entrypoint: `action:chat`
- Channels: `openpond_chat`
- Required integrations: none
- Required env/secrets: none
- Required volumes: none
- Schedules: none
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Deploy-plan expectation: can run after source upload and validation; can publish after inspect/build/validate/eval pass and source ref/SHA is present.

Safe Builder Chat edit scenario:

- Request: "Make the blank agent ask for a project name when the user is vague."
- Expected source changes: `agent/workflows/chat.ts`, optionally `agent/evals/basic.eval.ts` and `agent/instructions.md`
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Expected trace/eval artifacts: new `vague-request-asks-clarifying-question` eval result plus trace JSONL under `.openpond/traces/`

Channel scenario:

- OpenPond Chat is enabled by default and targets `chat`.
- Slack, Teams, MCP, API, schedule, and manual surfaces are intentionally absent in this minimal pilot.

Migration note:

- This is the no-template TypeScript-first scaffold. It should not generate or require `openpond.yaml`.

## Customer Reply Agent

Purpose: small first-party template with generated prompt pieces and optional Slack setup.

Source tree:

```text
examples/customer-reply-agent/
  README.md
  package.json
  agent/actions.ts
  agent/agent.ts
  agent/channels/openpond-chat.ts
  agent/channels/slack.ts
  agent/editable.ts
  agent/evals/reply.eval.ts
  agent/instructions.md
  agent/instructions.ts
  agent/integrations.ts
  agent/skills/reply-style.md
  agent/skills/reply-style.ts
  agent/workflows/chat.ts
```

Generated artifact tree:

```text
examples/customer-reply-agent/.openpond/
  action-registry.json
  agent-inspect.json
  agent-manifest.json
  artifact-index.json
  eval-results.json
  openpond-manifest.preview.yaml
  prompts/instructions.md
  runtime-bridge.mjs
  skills/reply-style/SKILL.md
  traces/*.jsonl
  validator-report.md
```

Setup slots and inspect/deploy-plan projection:

- Actions: `chat`, `draft-customer-reply`
- Default entrypoint: `action:chat`
- Channels: `openpond_chat`, `slack`
- Integrations: `openpond_chat` required; `slack` optional with `slack.message.ingest`
- Required env/secrets: none
- Required volumes: none
- Schedules: none
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Deploy-plan expectation: OpenPond Chat is ready immediately; Slack remains an optional setup warning until connected/enabled by the platform.

Safe Builder Chat edit scenario:

- Request: "Make replies more empathetic but keep them under four sentences."
- Expected source changes: `agent/instructions.ts`, `agent/skills/reply-style.ts`, and `agent/evals/reply.eval.ts`
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Expected trace/eval artifacts: updated `drafts-customer-reply` eval result plus trace JSONL under `.openpond/traces/`

Channel scenario:

- OpenPond Chat targets `chat` and is enabled by default.
- Slack targets `chat`, normalizes Slack text to `AgentChatInput`, renders text responses, and requires Slack setup before platform delivery.

Migration note:

- This is the template-copy TypeScript-first path. It may coexist with future `openpond.yaml` migration docs, but should not emit YAML as the authoring source.

## Water Estimator Agent

Purpose: complex workflow pilot that proves actions, workflows, tools, Teams/Microsoft setup, Slack, MCP, schedules, persistent volumes, generated artifacts, traces, evals, and editable checks.

Source tree:

```text
examples/water-estimator-agent/
  CROSSWALK.md
  README.md
  package.json
  src/README.md
  generated/agent-inspect.preview.json
  generated/agent-manifest.preview.json
  generated/openpond-manifest.preview.yaml
  generated/validator-report.preview.md
  agent/actions.ts
  agent/agent.ts
  agent/channels/mcp.ts
  agent/channels/microsoft-teams.ts
  agent/channels/openpond-chat.ts
  agent/channels/slack.ts
  agent/editable.ts
  agent/evals/clarifying-question.eval.ts
  agent/evals/estimate-review.eval.ts
  agent/evals/generate-task-plan.eval.ts
  agent/instructions.md
  agent/integrations.ts
  agent/schedules/daily-estimate-digest.ts
  agent/skills/water-estimator-process.md
  agent/tools/water-estimator-tools.ts
  agent/volumes.ts
  agent/workflows/chat.ts
  agent/workflows/generate-estimate-review.ts
  agent/workflows/generate-task-plan.ts
  agent/workflows/task-plan-history.ts
  agent/workflows/task-plan-revision.ts
  agent/workflows/task-plan-steps.ts
```

Generated artifact tree:

```text
examples/water-estimator-agent/.openpond/
  action-registry.json
  agent-inspect.json
  agent-manifest.json
  artifact-index.json
  eval-results.json
  openpond-manifest.preview.yaml
  prompts/instructions.md
  runtime-bridge.mjs
  skills/water-estimator-process/SKILL.md
  traces/*.jsonl
  validator-report.md
```

Setup slots and inspect/deploy-plan projection:

- Actions: `chat`, `generate-task-plan`, `render-drawings`, `extract-sheet-index`, `extract-page-tasks`, `consolidate-task-plan`, `export-task-plan`, `generate-estimate`, `task-plan-history`, `revise-task-plan`
- Default entrypoint: `action:chat`
- Channels: `openpond_chat`, `microsoft_teams`, `slack`, `mcp`
- Integrations: `opchat`, `microsoft_teams`, `slack`
- Required env/secrets: none
- Required volumes: `drawing-plans`, `water-history`
- Schedules: `daily-estimate-digest`, disabled by default
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Deploy-plan expectation: chat and MCP can be projected without external bot setup; Teams/Slack delivery require selected connections; both required volumes must be selected or provisioned before publish; the schedule stays disabled until explicitly enabled.

Safe Builder Chat edit scenario:

- Request: "Add a report mode that summarizes only the first five pages of each drawing set."
- Expected source changes: `agent/workflows/generate-task-plan.ts`, `agent/tools/water-estimator-tools.ts`, `agent/evals/generate-task-plan.eval.ts`, and optionally `agent/instructions.md`
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Expected trace/eval artifacts: updated `drawing-pdf-generates-task-plan` eval result, task-plan workflow trace spans, and artifact refs for task-plan output

Channel scenario:

- OpenPond Chat targets `chat`.
- Microsoft Teams targets `chat`, requires `microsoft_teams`, and needs message/file capabilities before platform delivery.
- Slack targets `chat`, requires `slack`, and needs message/file capabilities before platform delivery.
- MCP exposes the same `chat` intent router without a human chat surface.
- `daily-estimate-digest` is a schedule surface and remains disabled until platform setup enables it.

Volume/setup scenario:

- `drawing-plans`: `select-or-create`, project scope, upload-capable, required.
- `water-history`: `select-or-create`, project scope, required.
- Missing binding behavior: deploy/publish blocks until both volume refs are selected or provisioned by the platform.
- Provision-managed behavior: platform may create retained project volumes from the source policy.

Migration note:

- Existing `openpond.yaml` water-estimator projects can remain YAML-first while the TypeScript pilot proves parity.
- TypeScript-first migration should remove committed `openpond.yaml` or switch to `manifestMode: "extends-openpond-yaml"` when intentionally extending a legacy manifest.

## Integration Heavy Agent

Purpose: compact setup-heavy pilot for integrations, env/secrets, volume setup, schedule setup, evals, traces, and edit policy.

Source tree:

```text
examples/integration-heavy-agent/
  README.md
  package.json
  agent/agent.ts
  agent/instructions.md
```

Generated artifact tree:

```text
examples/integration-heavy-agent/.openpond/
  action-registry.json
  agent-inspect.json
  agent-manifest.json
  artifact-index.json
  eval-results.json
  openpond-manifest.preview.yaml
  prompts/instructions.md
  runtime-bridge.mjs
  skills/summary-style/SKILL.md
  traces/*.jsonl
  validator-report.md
```

Setup slots and inspect/deploy-plan projection:

- Actions: `chat`
- Default entrypoint: `action:chat`
- Channels: `openpond_chat`, `slack`
- Integrations: required `slack`, required `opchat`, optional `github`
- Required env/secrets: `OPENAI_API_KEY`
- Required volumes: `project-state`
- Schedules: `weekday-summary`, disabled by default
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Deploy-plan expectation: publish blocks until required Slack, opchat permission, `OPENAI_API_KEY`, and `project-state` volume setup are satisfied; optional GitHub should remain a warning or later setup prompt.

Safe Builder Chat edit scenario:

- Request: "Add a GitHub issue summary line when GitHub is connected."
- Expected source changes: `agent/agent.ts` and optionally an eval fixture inside the same source file or a future `agent/evals/*` split
- Required checks: `openpond-agent validate`, `openpond-agent eval`
- Expected trace/eval artifacts: updated `summarizes-update` eval result and trace JSONL under `.openpond/traces/`

Channel scenario:

- OpenPond Chat targets `chat`.
- Slack targets `chat`, requires `slack`, and needs `slack.message.ingest` for inbound context.
- API, MCP, Teams, schedule, and manual action surfaces are intentionally represented elsewhere.
- `weekday-summary` is the schedule surface and remains disabled until platform setup enables it.

Volume/setup scenario:

- `project-state`: `select-or-create`, project scope, required.
- Missing binding behavior: deploy/publish blocks until the platform has selected or provisioned a volume ref.
- Provision-managed behavior: platform may create the project-scoped state volume from the source policy.

Migration note:

- This pilot is TypeScript-first and intentionally compact. It is the best fixture for future Python/Rust parity because the generated inspect/setup shape is more important than file layout complexity.

## Channel Coverage Matrix

| Surface | Covered by | Setup blocker |
| --- | --- | --- |
| OpenPond Chat | blank-agent, customer-reply-agent, water-estimator-agent, integration-heavy-agent | none unless the platform disables the channel |
| Slack | customer-reply-agent, water-estimator-agent, integration-heavy-agent | selected Slack connection/lease for delivery |
| Microsoft Teams | water-estimator-agent | selected Microsoft Teams connection/lease for delivery |
| MCP | water-estimator-agent | platform MCP route/binding |
| API | source-backed `chat` action through platform API run path | platform runtime credential and selected agent binding |
| Schedule | water-estimator-agent, integration-heavy-agent | schedule row created disabled, then explicitly enabled after setup |
| Manual action | every declared non-chat action on water-estimator-agent | selected action and required runtime setup |

## Volume And Setup Matrix

| Pilot | Volumes | Env/secrets | Required integrations | Blocked setup examples |
| --- | --- | --- | --- | --- |
| blank-agent | none | none | none | none |
| customer-reply-agent | none | none | OpenPond Chat, optional Slack | Slack delivery blocked until Slack is connected |
| water-estimator-agent | `drawing-plans`, `water-history` | none | Teams/Slack delivery, optional opchat | missing volume refs, missing Teams/Slack connection, disabled schedule |
| integration-heavy-agent | `project-state` | `OPENAI_API_KEY` | Slack, opchat, optional GitHub | missing secret ref, missing Slack/opchat setup, missing volume ref, disabled schedule |

## Migration Paths

- YAML-first: keep `openpond.yaml` as source of truth for non-TypeScript or existing projects; the platform continues to consume the manifest path.
- TypeScript-first: create `agent/agent.ts` with `manifestMode: "typescript"` and do not commit root `openpond.yaml`.
- TypeScript extending YAML: set `manifestMode: "extends-openpond-yaml"` and `extendsManifest` when a TypeScript project intentionally extends a checked-in manifest.
- Future Python/Rust: generate the same inspect JSON and manifest/runtime artifacts as these pilots, then reuse the same platform setup, trace, eval, and publish path.
