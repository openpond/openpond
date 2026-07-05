# Public API Map

OpenPond agent projects should import from public package subpaths only. Do not import from `src/*`, `dist/*`, `core/*`, `commands/*`, or `cli/*`.

## Authoring Primitives

- `openpond-agent-sdk/primitives`: `defineAgentProject`, `defineAgent`, `defineLocalAgent`, `defineRemoteAgent`, `defineMcpClientConnection`, `action`, `defineAction`, `defineIntent`, `defineIntentRouter`, `defineWorkflow`, `defineTool`, `defineEval`, `defineInstructions`, `defineSkill`, `editable`, `integration`, `defineIntegration`, `env`, `secret`, `defineEnvSecret`, `volume`, `defineVolume`, and `schedule`.
- `openpond-agent-sdk/channels`: `defineChannel`, `normalizeChannelEvent`, `renderChannelResponse`, `inspectChannelSetup`, and `listChannelSetups`.
- `openpond-agent-sdk/instructions`: generated or markdown-backed root instruction definitions.
- `openpond-agent-sdk/skills`: generated or markdown-backed skill package definitions.
- `openpond-agent-sdk/integrations`: provider/capability and env/secret declarations, including `connectedIntegration`, `integration.google`, `integration.github`, and `integration.x` helpers backed by the shared connected-app bundle metadata. Slack and Microsoft Teams remain native ingestion/channel integrations, not OAuth lease helpers.
- `openpond-agent-sdk/volumes`: source-declared volume requirements.
- `openpond-agent-sdk/schedules`: source-declared cron/rate schedule requirements.
- `openpond-agent-sdk/workflow`: workflow definitions that run inside normal action execution.
- `openpond-agent-sdk/editable`: Builder Chat/source edit policy declarations.
- `JsonSchema`: JSON-schema-shaped input declarations used by `defineAgentProject({ inputSchema, inputSchemas })`.

## Runtime And Checks

- `openpond-agent-sdk/runtime`: local execution helpers such as `inspectActions`, `runAction`, `runChatAction`, `runEval`, `executeAction`, `createRunState`, `createEvalContext`, and `writeTrace`.
- `openpond-agent-sdk/eval`: eval definition helpers.
- `openpond-agent-sdk/tracing`: trace artifact helpers.
- `openpond-agent-sdk/validator`: `validateAgentProject`, `formatValidationReport`, and `writeValidationReport`.
- `openpond-agent-sdk/manifest`: action catalog, manifest, action-registry, runtime-bridge, artifact-index, and schema compatibility helpers.
- `openpond-agent-sdk/schemas`: `ARTIFACT_SCHEMAS` and `SDK_SCHEMA_VERSION`.

## Source Of Truth

New TypeScript projects use `agent/agent.ts` with `manifestMode: "typescript"`. Portable or non-TypeScript projects can use `openpond.yaml`. TypeScript projects that intentionally extend an existing manifest must set `manifestMode: "extends-openpond-yaml"` and `extendsManifest`.

## Action-First Contract

`defineAction` is the public exposure primitive. Every exposed runtime entry has an action `id`, optional label, schemas, setup requirements, approval policy, artifact policy, trace policy, model policy, and optional MCP export metadata. Local agents, remote agents, workflows, tools, and MCP client connections are implementation helpers behind actions; they are not public entries unless an action wraps them.

Generated `.openpond/agent-inspect.json`, `.openpond/agent-manifest.json`, and `.openpond/action-registry.json` include `actionCatalog`, implementation references, provider setup, model policy, and MCP export metadata. Platform code should prefer `actionCatalog[].id` over legacy `actions[].name`.
