# OpenPond Agent SDK

The OpenPond Agent SDK turns agents into TypeScript projects. The SDK owns source authoring, local inspection, generated runtime artifacts, validation, local action runs, traces, evals, and edit policy.

OpenPond Cloud owns platform bindings such as integration leases, secret refs, volume provisioning, hosted execution, source promotion, run history, and durable cloud conversations.

## Create An Agent

Create from a template:

```bash
openpond-agent init blank-agent --cwd ./my-agent
openpond-agent init customer-reply-agent --cwd ./customer-reply
openpond-agent init integration-heavy-agent --cwd ./ops-agent
```

From this monorepo, run SDK commands through the package workspace:

```bash
pnpm --dir packages/agent-sdk build
pnpm --dir packages/agent-sdk validate --cwd examples/blank-agent
pnpm --dir packages/agent-sdk eval --cwd examples/blank-agent
```

## Source Layout

```text
agent/
  agent.ts
  instructions.md or instructions.ts
  actions/
  agents/
  remote-agents/
  workflows/
  tools/
  connections/
  channels/
  evals/
  schedules/
  editable.ts
src/
  implementation files
```

`agent/agent.ts` is the source of truth. It declares the agent project, public actions, runtime shape, setup requirements, evals, and the generated OpenPond manifest.

## Generated Artifacts

`openpond-agent build` writes deterministic artifacts under `.openpond/`:

```text
.openpond/agent-manifest.json
.openpond/action-registry.json
.openpond/agent-inspect.json
.openpond/artifact-index.json
.openpond/openpond-manifest.preview.yaml
.openpond/runtime-bridge.mjs
.openpond/validator-report.md
.openpond/prompts/instructions.md
.openpond/skills/<skill>/SKILL.md
.openpond/eval-results.json
.openpond/traces/*.jsonl
```

These artifacts are the bridge between source-owned agent code and platform-owned runtime infrastructure.

## Editing Agents

Agent edits should happen in source, not by hand-editing generated artifacts.

1. Edit files under `agent/` and `src/`.
2. Run inspect or build to regenerate `.openpond/` artifacts.
3. Run validation to catch missing setup, schema issues, or unsafe action declarations.
4. Run evals to prove behavior against repeatable fixtures.
5. Commit the source and regenerated artifacts that are expected to travel with the agent.

The `editable.ts` policy tells OpenPond Builder Chat and coding workflows which files are in scope and which checks must pass before an edit can publish.

In an OpenPond chat with an editable Profile selected, `/agent create` and `/agent improve <agent-id>` use the same source-first workflow. They are ordinary skill-backed model turns, not Goal or Create/Improve modes. Supporting tools expose the SDK operations as `agent_inspect`, `agent_build`, `agent_validate`, `agent_eval`, `agent_run`, and `agent_traces`; `agent_check` is the required completion gate:

```text
inspect -> build -> validate -> eval
```

The tools accept an exact enabled Profile Agent ID and re-resolve it beneath the selected Profile root. They do not accept an arbitrary working directory or own the authoring objective. File changes remain visible ordinary source edits, and OpenPond does not create a branch, candidate, promotion, or Apply step automatically.

## Public Runtime Surface

Actions are the public runtime surface. Workflows, local agents, remote-agent refs, tools, channels, integrations, and schedules stay behind those actions so web UI, chat, MCP, evals, and hosted runs can all call the same action catalog.
