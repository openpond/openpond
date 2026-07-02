# Water Estimator Original Project Crosswalk

Original project: `/home/glu/Projects/all/openpond-cloud-water-estimator-example`.

This file maps the original runtime shape into the SDK pilot so gaps are visible before platform work depends on the conversion.

## Current Audit

Re-run on 2026-06-18 against the original `openpond.yaml` and current SDK build output:

- No original action is missing from the SDK pilot.
- Original action timeouts match SDK action timeouts.
- The SDK pilot adds `task-plan-history` as a first-class action because the original source has `src/task-plan-history.ts` and history behavior was otherwise only reachable through `chat`.
- Original `artifacts/workflow-events.jsonl` is intentionally replaced by SDK trace JSONL. The generated runtime manifest exposes `artifacts/openpond-trace.jsonl`, and detailed traces are written under `.openpond/traces/*.jsonl`.
- The original upload/input form is now represented in TypeScript source at `agent/input-schema.ts` and compiles into `inputs.schema` in `.openpond/openpond-manifest.preview.yaml`.

## Actions And Commands

| Original `openpond.yaml` / script | SDK source |
| --- | --- |
| `chat` -> `bun src/actions/chat.ts` | `agent/actions.ts` action `chat` targeting `agent/workflows/chat.ts` intent router |
| `generate-task-plan` -> `bun src/generate-task-plan.ts generate` | `agent/actions.ts` action `generate-task-plan` targeting `agent/workflows/generate-task-plan.ts` |
| `render-drawings` -> `bun src/render-drawings.ts` | `agent/actions.ts` action `render-drawings` targeting `agent/workflows/task-plan-steps.ts` |
| `extract-sheet-index` -> `bun src/generate-task-plan.ts extract-sheet-index` | `agent/actions.ts` action `extract-sheet-index` targeting `agent/workflows/task-plan-steps.ts` |
| `extract-page-tasks` -> `bun src/generate-task-plan.ts extract-page-tasks` | `agent/actions.ts` action `extract-page-tasks` targeting `agent/workflows/task-plan-steps.ts` |
| `consolidate-task-plan` -> `bun src/generate-task-plan.ts consolidate-task-plan` | `agent/actions.ts` action `consolidate-task-plan` targeting `agent/workflows/task-plan-steps.ts` |
| `export-task-plan` -> `bun src/generate-task-plan.ts export-task-plan` | `agent/actions.ts` action `export-task-plan` targeting `agent/workflows/task-plan-steps.ts` |
| `generate-estimate` -> `bun src/generate-estimate.ts` | `agent/actions.ts` action `generate-estimate` targeting `agent/workflows/generate-estimate-review.ts` |
| `revise-task-plan` -> `bun src/actions/revise-task-plan.ts` | `agent/actions.ts` action `revise-task-plan` targeting `agent/workflows/task-plan-revision.ts` |

The SDK pilot intentionally does not keep hand-authored `src/actions/*.ts` wrappers. `openpond-agent build` generates the runtime bridge from SDK-native actions.

## Workflows And Implementation Files

| Original source | SDK source |
| --- | --- |
| `src/actions/chat.ts` | split into `agent/workflows/chat.ts`, channel adapters, and typed actions |
| `src/generate-task-plan.ts` | `agent/workflows/generate-task-plan.ts` plus step workflows in `agent/workflows/task-plan-steps.ts` |
| `src/render-drawings.ts` | `agent/workflows/task-plan-steps.ts` render step |
| `src/generate-estimate.ts` | `agent/workflows/generate-estimate-review.ts` |
| `src/task-plan-history.ts` | `agent/workflows/task-plan-history.ts` |
| `src/task-plan-revisions.ts` and `src/actions/revise-task-plan.ts` | `agent/workflows/task-plan-revision.ts` |
| `src/task-plan-ledger.ts` | represented by task-plan export and history artifacts |
| `src/xlsx-writer.ts` | represented by task-plan and estimate XLSX artifact declarations |
| `src/openpond-runtime.ts` | replaced by SDK runtime context helpers and generated bridge |

The pilot keeps `src/README.md` as the placeholder for implementation modules that would move over from the original project after the contract is proven.

## Inputs And Uploads

| Original `inputs.schema` field | SDK source |
| --- | --- |
| `drawingFiles`, `drawingFile` PDF uploads to `volumes/drawing-plans/drawings` | `agent/input-schema.ts` `waterEstimatorInputSchema` |
| `historyFiles` spreadsheet/CSV uploads to `volumes/water-history/history` | `agent/input-schema.ts` `waterEstimatorInputSchema` |
| `proposalFile` uploads to `volumes/water-history/proposals` | `agent/input-schema.ts` `waterEstimatorInputSchema` |
| proposal/query/history/revision fields | `agent/input-schema.ts` `waterEstimatorInputSchema` |
| render/task page controls and vision model controls | `agent/input-schema.ts` `waterEstimatorInputSchema` |

The schema is attached to `defineAgentProject({ inputSchema, inputSchemas })`. `openpond-agent build` compiles it into the generated runtime preview under `inputs.schema`, preserving `x-openpond-upload` metadata for platform forms.

## Integrations And Channels

| Original behavior | SDK source |
| --- | --- |
| OpenPond Chat-compatible `chat` action | `agent/channels/openpond-chat.ts` -> `chat` |
| Teams natural message input and Microsoft file upload/download behavior | `agent/channels/microsoft-teams.ts` plus `agent/integrations.ts` Microsoft Teams capabilities |
| Slack-ready chat surface | `agent/channels/slack.ts` plus Slack capabilities |
| MCP/API-style tool access | `agent/channels/mcp.ts` and SDK actions/tools |
| Model gateway usage | `agent/integrations.ts` `opchat` declaration |

Provider auth, OAuth leases, bot installation, and connection ids remain OpenPond platform state. The SDK source declares required capabilities only.

## Volumes And State

| Original `openpond.yaml` volume | SDK source |
| --- | --- |
| `drawing-plans` at `/workspace/volumes/drawing-plans`, 8 GB, retained | `agent/volumes.ts` `drawing-plans` with `select-or-create` project provisioning |
| `water-history` at `/workspace/volumes/water-history`, 8 GB, retained | `agent/volumes.ts` `water-history` with `select-or-create` project provisioning and SQLite state policy |

Original SQLite files under `volumes/*/task-plans.sqlite` map to agent-owned state on the `water-history` mounted volume. They do not move into the OpenPond control-plane database.

## Artifacts

Original artifact paths are preserved or intentionally renamed only when the SDK shape needs a more explicit source contract.

| Original artifacts | SDK actions |
| --- | --- |
| drawing render manifest and rendered pages CSV | `render-drawings`, `generate-task-plan`, `chat` |
| sheet index, page extractions, consolidated task plan | `extract-sheet-index`, `extract-page-tasks`, `consolidate-task-plan`, `generate-task-plan`, `chat` |
| task-plan CSV/XLSX/export JSON/ledger | `export-task-plan`, `generate-task-plan`, `chat` |
| proposal review, example estimate JSON/CSV/XLSX, search results, import summary | `generate-estimate`, `chat` |
| history answer and candidates | `task-plan-history`, `chat` |
| task-plan revision and v2/approved exports | `revise-task-plan`, `chat` |
| workflow events JSONL | superseded by `.openpond/traces/*.jsonl` and `artifacts/openpond-trace.jsonl` while action-specific artifacts stay declared |

## Fixtures And Tests

| Original test/fixture | SDK pilot |
| --- | --- |
| `fixtures/synthetic-water-plan.pdf` | represented by `agent/evals/generate-task-plan.eval.ts` fixture-style eval input |
| `src/tests/chat.test.ts` | `agent/evals/clarifying-question.eval.ts` plus `agent/evals/generate-task-plan.eval.ts` |
| `src/tests/generate-task-plan.test.ts` | `agent/evals/generate-task-plan.eval.ts` |
| `src/tests/task-plan-history.test.ts` | `agent/evals/estimate-review.eval.ts` covers history/proposal routing; full history regression remains out of v1 pilot scope |
| `src/tests/task-plan-ledger.test.ts` | artifact declaration and task-plan export coverage; full ledger mutation test remains out of v1 pilot scope |
| `src/tests/task-plan-revisions.test.ts` | action/tool/workflow declaration coverage; full revision mutation test remains out of v1 pilot scope |

Out-of-v1 items are implementation regressions, not source-contract blockers. The Phase 2 goal is proving that the complex workflow shape, setup requirements, actions, tools, channels, volumes, schedules, artifacts, traces, evals, and edit policy are expressible and inspectable through the SDK.
