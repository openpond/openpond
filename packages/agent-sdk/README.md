# OpenPond Agent SDK

This folder is the local TypeScript-first Agent SDK package. It is intentionally not published to npm yet, but it is executable locally and should stay clean enough to become a public repository.

The package name is:

```text
openpond-agent-sdk
```

The local CLI is:

```text
openpond-agent
```

## Templates

Create a new local agent project from a packaged template:

```bash
openpond-agent init blank-agent --cwd ./my-agent
openpond-agent init customer-reply-agent --cwd ./customer-reply
openpond-agent init integration-heavy-agent --cwd ./ops-agent
```

Templates included in the package:

- `blank-agent`: minimal OpenPond Chat agent with one intent, one skill, one eval, and edit policy.
- `customer-reply-agent`: small customer-response template with optional Slack setup.
- `integration-heavy-agent`: setup-heavy template with Slack, model access, env/secret refs, a project volume, a disabled schedule, artifacts, evals, and edit policy.

The current local examples are:

- `examples/PILOT-SCENARIOS.md`: checked pilot snapshots, setup projections, edit scenarios, channel coverage, volume/setup cases, and migration notes.
- `examples/blank-agent`: raw/blank scaffold for the no-template path.
- `examples/customer-reply-agent`: small first-party template proving template-copy ergonomics.
- `examples/water-estimator-agent`: complex workflow example with actions, tools, workflows, integrations, volumes, channels, schedules, evals, and editable policy.
- `examples/integration-heavy-agent`: setup-heavy example proving integrations, env/secrets, volumes, schedules, artifacts, evals, and edit policy.

Package docs live under `docs/`:

- `docs/api.md`: public API and subpath map.
- `docs/authoring.md`: source layout and authoring guide.
- `docs/cli.md`: CLI command reference.
- `docs/artifacts.md`: generated artifact and schema reference.
- `docs/feature-matrix.md`: Feature Matrix for public primitives, CLI commands, generated fields, tests, and platform consumers.
- `docs/platform-boundary.md`: Platform Boundary for source-owned declarations versus OpenPond-owned setup, storage, source refs, and run history.
- `docs/cli-machine-output.md`: CLI Machine Output, exit codes, stable JSON fields, and downstream consumption rules.
- `docs/validation.md`: validation report and issue code catalog.
- `docs/negative-validation-examples.md`: Negative Validation Examples for validation-blocking setup states and failing eval gates.
- `docs/tracing-evals.md`: trace and eval behavior.
- `docs/templates.md`: templates and examples policy.
- `docs/migration.md`: TypeScript, `openpond.yaml`, extension, and future SDK migration notes.

An SDK agent project layout is:

```text
examples/<agent-name>/
  agent/agent.ts
  agent/actions/*
  agent/agents/*
  agent/remote-agents/*
  agent/connections/*
  agent/editable.ts
  agent/volumes.ts
  agent/workflows/*
  agent/tools/*
  agent/channels/*
  agent/evals/*
  agent/schedules/*
  src/*
  .openpond/agent-inspect.json
  .openpond/agent-manifest.json
  .openpond/action-registry.json
  .openpond/openpond-manifest.preview.yaml
  .openpond/eval-results.json
  .openpond/traces/*
```

The package demonstrates the intended split:

```text
TypeScript source = authoring source of truth for new TS agents
generated manifest = OpenPond runtime contract
channels/* = surface adapters
action catalog = one flat public runtime surface
chat action = shared natural-language ingress for providers/MCP
actions/* = SDK-native runtime entrypoints
agents/* and remote-agents/* = implementation details behind actions
editable.ts = source-authored policy for Builder Chat / coding tasks
workflows/* = actual business flows
tools/* and connections/* = private implementation capabilities consumed by actions
evals/* = repeatable tests for behavior
agent-inspect.json = source inspection contract after source materialization
```

## Local Commands

Run these from this package root:

```bash
bun install
bun run inspect -- --cwd examples/blank-agent
bun run build -- --cwd examples/blank-agent
bun run validate -- --cwd examples/blank-agent
bun run eval -- --cwd examples/blank-agent
bun run check
```

Root scripts are package-first and do not name a specific example. Use `--cwd` to point the CLI at any SDK agent project and `--out-dir` when generated artifacts should go somewhere other than `.openpond`. `bun run check` runs typecheck, package tests, and the example matrix in `scripts/check-examples.ts`.

Each example also has local agent scripts:

```bash
cd examples/customer-reply-agent
bun run agent:inspect
bun run agent:build
bun run agent:validate
bun run agent:eval
```

The commands load the selected example's `agent/agent.ts`, generate `.openpond/*` artifacts, validate the source contract, run one local action, and run the SDK evals through a local stub runtime that records trace JSONL. Platform-only responsibilities such as hosted execution, integration leases, volume mounting, source promotion, and publish transactions stay outside this package.

## Public Exports

The package is split into public subpaths so user projects do not import private implementation modules:

```text
openpond-agent-sdk
openpond-agent-sdk/primitives
openpond-agent-sdk/channels
openpond-agent-sdk/editable
openpond-agent-sdk/eval
openpond-agent-sdk/inspect
openpond-agent-sdk/instructions
openpond-agent-sdk/integrations
openpond-agent-sdk/manifest
openpond-agent-sdk/runtime
openpond-agent-sdk/schedules
openpond-agent-sdk/schemas
openpond-agent-sdk/skills
openpond-agent-sdk/tracing
openpond-agent-sdk/validator
openpond-agent-sdk/volumes
openpond-agent-sdk/workflow
```

Authoring code should prefer the focused subpaths when that keeps imports clear, for example `openpond-agent-sdk/skills` for `defineSkill` and `openpond-agent-sdk/runtime` for local runner helpers.

## Generated Artifacts

`openpond-agent build` writes deterministic artifacts under `.openpond/` by default:

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

The JSON artifacts include schema ids and component schema ids for the flat action catalog, implementation refs, local/remote agents, MCP client connections, channels, integrations, env/secret refs, volumes, schedules, tools, workflows, intent routers, evals, editable policy, instructions, skills, traces, and validation output. `artifact-index.json` lists generated artifact paths, formats, kinds, and schemas so platform code can verify compatibility before consuming outputs.

## Validation

`openpond-agent validate --json` returns machine-readable validation:

```json
{
  "schema": "openpond.agent.validation.v1",
  "status": "passed",
  "summary": { "errors": 0, "warnings": 0 },
  "issues": []
}
```

Issues include stable `code`, `severity`, `path`, UI-safe `summary`, optional source location, optional setup requirement, and details. Compatibility `errors` and `warnings` arrays are still present for simple callers.

## Tracing

The local runner records trace JSONL through the runtime context. Agent workflows can use:

```ts
await ctx.step("load-context", async () => loadContext());
await ctx.model("draft-answer", async () => "Answer");
await ctx.tool("lookup", async () => ({ ok: true }));
ctx.trace.artifact("artifacts/result.json");
await ctx.loadSkill("reply-style");
```

Trace entries are redacted for secret-like keys and include schema metadata. The SDK does not call OpenPond Cloud from these helpers.

## Evals

`openpond-agent eval --json` runs source-defined evals beside the agent. Eval results include fixture hashes, source config hash, assertion records, trace refs, artifact refs, and a publish-gate rollup.

Eval files can use the context helpers:

```ts
await t.send({ prompt: "hello", channel: "openpond_chat" });
await t.runAction("chat", { prompt: "hello", channel: "openpond_chat" });
t.expectIntent("answer");
t.expectArtifact("artifacts/result.json");
t.expectTraceEvent("model.completed");
```

## Repository Shape

Keep the package organized as a public repo:

```text
src/
  cli.ts
  cli/
  commands/
  core/
  primitives/
  runtime/
  workflow/
  validator/
  index.ts
examples/
  blank-agent/
  customer-reply-agent/
  water-estimator-agent/
  integration-heavy-agent/
templates/
  blank-agent/
  customer-reply-agent/
  integration-heavy-agent/
scripts/
  check-examples.ts
  check-hygiene.ts
  check-package-install.ts
test/
```

Files should stay focused and comfortably under 1,000 lines.
