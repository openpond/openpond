# Water Estimator Agent SDK Example

This is the existing cloud water estimator represented with the local `openpond-agent-sdk` package.

See [CROSSWALK.md](./CROSSWALK.md) for the mapping from the original `/home/glu/Projects/all/openpond-cloud-water-estimator-example` files, actions, workflows, integrations, volumes, artifacts, fixtures, and tests into this SDK pilot.

The original project has a large `src/actions/chat.ts` that does several jobs:

- normalize OpenPond/Teams input
- stage drawing/history/proposal files
- infer which workflow should run
- run task-plan generation, estimate review, history lookup, or revision
- emit runtime updates and artifacts

This example moves the visible contract into source:

```text
agent/agent.ts                     Project contract and runtime manifest source
agent/actions.ts                   SDK-native action registry
agent/editable.ts                  Source-authored Builder Chat/coding-task policy
agent/volumes.ts                   Volume provisioning and selection policy
agent/workflows/chat.ts            Intent router
agent/workflows/generate-task-plan.ts
agent/workflows/generate-estimate-review.ts
agent/workflows/task-plan-history.ts
agent/workflows/task-plan-revision.ts
agent/channels/*                   Surface adapters into AgentChatInput
agent/evals/*                      Behavior tests
agent/skills/*                     Prompted workflow/process guidance
agent/schedules/*                  Source-authored schedules
src/*                              Existing implementation modules used by workflows
generated/agent-inspect.preview.json  Coding-core source inspection preview
```

The important product behavior:

```text
Teams / Slack / OpenPond Chat / MCP / API / schedule
  -> channel adapter
  -> AgentChatInput
  -> chat intent router
  -> typed workflow
  -> trace events + artifacts
  -> AgentChatResult
  -> channel response renderer
```

## Actions Vs Tools

This example intentionally has both actions and tools.

Actions are SDK-native runtime entrypoints that OpenPond can run directly:

- `chat`
- `generate-task-plan`
- `render-drawings`
- `extract-sheet-index`
- `extract-page-tasks`
- `consolidate-task-plan`
- `export-task-plan`
- `generate-estimate`
- `task-plan-history`
- `revise-task-plan`

Tools are user/model-facing capabilities backed by actions:

- `generate_task_plan`
- `review_water_estimate`
- `revise_task_plan`
- `lookup_task_plan_history`

The default end-user path is still `chat`, because it lets Slack, Teams, OpenPond Chat, MCP, API, and schedules share one intent router. Direct tools/actions remain important for UI forms, MCP tool exposure, evals, debugging, and workflow step reruns.

The SDK rule should be strict: an end-user tool is invalid unless it targets a declared action. A workflow can describe the internal code path for traces/evals, but the platform execution boundary is still the action.

The author should not write one `src/actions/*.ts` wrapper per action. If current OpenPond infrastructure still needs command-shaped actions, `openpond agent build` should generate the bridge internally, for example `openpond-agent run generate-task-plan`.

## Editable Policy

Agent Builder Chat and background edits are controlled by `agent/editable.ts`.

The source file declares:

- `openpond-coding-core-v1` as the edit runtime environment
- `openpond agent inspect --json` as the policy discovery command
- allowed edit paths for `agent/**`, `src/**`, `package.json`, and `README.md`
- required checks: `openpond-agent validate` and `openpond-agent eval`
- `patch_only` as the default result mode

The policy is source-authored. OpenPond can cache it for UI, but coding-core should re-run inspect after source materialization so it uses the policy from the checked-out commit. Git URLs, write credentials, patches, commits, branches, and PRs remain OpenPond control-plane responsibilities.

`generated/agent-inspect.preview.json` shows the JSON shape coding-core should consume after running inspect. That keeps the editing path in code without making coding-core import SDK internals or parse TypeScript files directly.

## Volumes

Volume selection and provisioning lives in `agent/volumes.ts`.

- `drawing-plans` is selected or created as a project volume for uploaded plan PDFs, rendered pages, and extraction artifacts.
- `water-history` is selected or created as a project volume for durable task-plan history and proposal review state.

This is the product flow the SDK should enable during project creation:

```text
selected agent template
  -> required volumes from agent/volumes.ts
  -> user selects existing volume or creates one
  -> runtime mounts selected volume at the declared mount path
  -> actions/tools read and write through that mount
```

For this example both volumes use `select-or-create` because repeated estimator runs should share the same history/drawing workspace unless the user intentionally starts a new one.

## Integrations

External integrations live in `agent/integrations.ts` and channel declarations:

- OpenPond model gateway through `opchat`
- Microsoft Teams and Microsoft file capabilities
- Slack message/file capabilities

The channel files declare which connection a surface needs before it can be enabled. File discovery alone does not activate Slack or Teams.

## SQLite State

The current water estimator keeps task-plan history and ledgers in SQLite. That is still fine when the SQLite database is agent-owned state on a durable OpenPond volume.

The intended rule is:

```text
SQLite on mounted volume = agent-local state/history/cache
OpenPond control-plane DB = product metadata, runs, chats, traces/eval refs, billing, permissions
```

SQLite is appropriate for this example because the history belongs to the agent workspace and can be checkpointed with the volume. If multiple concurrent runs need to write the same SQLite file, the runtime should serialize writes or enforce a single-writer policy.

The generated preview at `generated/openpond-manifest.preview.yaml` shows the runtime contract that current OpenPond infrastructure would consume. In a real TypeScript-first agent this file can be a build artifact instead of checked in.

`generated/agent-manifest.preview.json` shows the SDK-level metadata that does not naturally belong in today's `openpond.yaml`, such as tools, channels, intent router, and volume-backed state policy.

## Local Commands And Generated Outputs

```bash
bun run agent:inspect
bun run agent:build
bun run agent:validate
bun run agent:eval
openpond-agent run chat --input '{"prompt":"Can you help with this project?","channel":"openpond_chat"}'
```

Generated outputs:

- `.openpond/agent-inspect.json`
- `.openpond/agent-manifest.json`
- `.openpond/action-registry.json`
- `.openpond/artifact-index.json`
- `.openpond/openpond-manifest.preview.yaml`
- `.openpond/eval-results.json`
- `.openpond/traces/*.jsonl`

This pilot proves the complex path: long-running actions, Teams/Microsoft setup requirements, Slack/MCP/OpenPond Chat channels, persistent project volumes, generated runtime bridge, task-plan and estimate artifacts, source-defined evals, trace artifacts, and Builder Chat edit policy.
