# SDK Feature Matrix

This matrix is the package-level compatibility artifact for platform consumers. It maps public authoring APIs and CLI commands to generated artifacts, inspect fields, validation rules, examples, tests, and the expected OpenPond consumer.

## Public Primitives

| API | Manifest fields | Inspect fields | Validation coverage | Example coverage | Test coverage | Platform consumer |
| --- | --- | --- | --- | --- | --- | --- |
| `defineAgentProject` | `project`, `runtime`, `defaultEntrypoint`, `sourceOfTruth` | `project`, `agent`, `sourceLayout`, `sourceOfTruth` | `project_name_required`, `project_version_required`, source-of-truth issues | all examples | `primitive-contract`, `source-loader-contract`, `inspect-contract` | source upload, deploy plan, manifest snapshots |
| `inputSchema` / `inputSchemas` | `inputSchema`, `inputSchemas`, runtime `inputs.schema` | `inputSchema`, `inputSchemas` | generated artifact and pilot coverage | water estimator | `pilot-examples-contract` | create-project forms, file upload routing, action/tool input UI |
| `defineAgent` / `defineLocalAgent` | `agents[]`, implementation refs when used as a local agent; project fields when used as legacy project alias | `implementationRefs.agents`, `capabilities.agents` | `action_target_agent_missing` | contract fixtures | `primitive-contract`, `runtime-runner-contract` | action-backed agent implementation calls |
| `defineRemoteAgent` | `remoteAgents[]`, action implementation refs | `implementationRefs.remoteAgents`, `capabilities.remoteAgents` | `remote_agent_duplicate`, `remote_agent_target_missing`, `remote_agent_auth_gap`, `action_target_remote_agent_missing` | contract fixtures | `validation-issues-contract` | remote agent action bridge, trace parent/child linkage |
| `defineMcpClientConnection` | `connections[]`, setup connection projection | `implementationRefs.connections`, `setup.connections`, `capabilities.connections` | `mcp_connection_duplicate`, `mcp_connection_server_url_missing`, `mcp_connection_tool_filter_missing` | contract fixtures | `primitive-contract`, `validation-issues-contract` | actions/agents consuming external MCP servers |
| `action` / `defineAction` | `actionCatalog[]`, `actions[]`, `defaultEntrypoint`, action registry, MCP export metadata | `actionCatalog`, `mcpExports`, `capabilities.actions`, `agent.defaultAction` | `action_required`, `action_duplicate`, `action_id_duplicate`, `action_direct_input_schema_missing`, `mcp_export_input_schema_missing`, `mcp_export_visibility_unsafe`, `default_action_missing`, target issues | all examples | `primitive-contract`, `runtime-runner-contract`, `validation-issues-contract` | web/app slash picker, hosted action registry, MCP tools, provider dispatch |
| `defineWorkflow` | `workflows[]`, action target refs | `capabilities.workflows` | `action_target_workflow_missing`, `tool_target_workflow_missing` | water estimator, integration-heavy, blank, customer-reply | `primitive-contract`, `runtime-runner-contract` | hosted action runtime, trace spans |
| `defineTool` | `tools[]` | `capabilities.tools` | `tool_target_action_missing`, `tool_target_workflow_missing` | water estimator, primitive fixture | `primitive-contract`, `validation-issues-contract` | end-user tool inventory, model-facing tool list |
| `defineIntent` | intent router `intents[]` | through default action/router metadata | `intent_duplicate`, `intent_default_missing` | all chat examples | `primitive-contract`, `runtime-runner-contract`, `validation-issues-contract` | chat action routing, trace summaries |
| `defineIntentRouter` | `chat`, action target router | `agent.defaultAction`, `capabilities.actions` | router intent issues | all chat examples | `primitive-contract`, `runtime-runner-contract` | OpenPond Chat, Slack, Teams, MCP, API ingress |
| `defineChannel` | `channels[]`, adapter contract, setup requirements | `setup.channels`, `providerSupport`, `capabilities.channels` | `channel_target_action_missing`, `channel_missing_integration_requirement`, `chat_action_required`, `channel_business_routing_forbidden` | all examples, integration-heavy covers setup | `channel-adapter-contract`, `pilot-examples-contract` | channel setup UI, delivery adapters |
| `defineSchedule` / `schedule` | `schedules[]`, runtime manifest schedules | `setup.schedules`, `capabilities.schedules` | `schedule_target_action_missing` | water estimator, integration-heavy, validation-failures | `validation-issues-contract`, `pilot-examples-contract` | scheduler setup, disabled-by-default UI |
| `defineEval` | `evals[]`, eval results, publish gate | `capabilities.evals`, `validation.requiredChecks` | `eval_expected_artifact_not_declared` | all examples, validation-failures | `primitive-contract`, `runtime-runner-contract`, `artifact-index-contract` | source checks, publish gates, eval summaries |
| `defineInstructions` | `instructions`, compiled prompt artifact | generated prompt refs via build artifacts | `source_file_missing` | blank markdown, customer generated | `primitive-contract`, `source-loader-contract` | prompt preview, manifest snapshot |
| `defineSkill` | `skills[]`, compiled `SKILL.md` package | generated skill refs via build artifacts | `skill_description_missing`, `skill_source_missing`, unsafe file issues | blank markdown, customer generated, validation-failures | `primitive-contract`, `validation-issues-contract` | skill preview, coding edit context |
| `defineIntegration` / `integration` / `connectedIntegration` | `integrations[]`, runtime required leases/permissions, bundle-backed provider/capability ids | `setup.integrations`, `capabilities.integrations` | channel/integration setup warnings, secret leakage, connected capability validation | customer optional Slack, water Teams/Microsoft, integration-heavy, primitive Google lease fixture | `primitive-contract`, `pilot-examples-contract` | connection setup, lease selection, connected-app bundle projection |
| `defineEnvSecret` / `env` / `secret` | `envRefs[]`, runtime `inputs.env` | `setup.envRefs`, `capabilities.env` | `env_name_required`, `env_duplicate`, `env_secret_value_inline` | integration-heavy, primitive fixture, validation-failures | `primitive-contract`, `validation-issues-contract` | secret setup UI, deploy blockers |
| `defineVolume` / `volume` | `volumes[]`, runtime manifest volumes | `setup.volumes`, `capabilities.volumes` | `volume_used_by_action_missing` | water estimator, integration-heavy, validation-failures | `primitive-contract`, `pilot-examples-contract` | volume selection/provisioning |
| `editable` | `editable` policy | `editable`, `validation.requiredChecks` | editable backend/paths/check issues | all happy-path examples | `primitive-contract`, `validation-issues-contract` | source-edit discovery, Builder Chat |

## CLI Commands

| Command | Generated artifacts | Machine output | Exit status | Downstream consumer |
| --- | --- | --- | --- | --- |
| `openpond-agent init` | copied template source | text only | nonzero on copy/argument errors | project wizard/template copy |
| `openpond-agent inspect --json` | `.openpond/agent-inspect.json` | inspect JSON | nonzero on load errors | source-edit checks, web/app projections |
| `openpond-agent build` | manifest, registry, runtime bridge, prompt/skill artifacts, validator report, artifact index | text only | nonzero on validation/build errors | source upload, runtime manifest preview |
| `openpond-agent validate --json` | validator report | validation JSON | nonzero when validation errors exist | deploy plan, source checks, publish gating |
| `openpond-agent eval --json` | eval results, trace JSONL, artifact index | eval results JSON | nonzero when any eval fails | source checks, publish gates |
| `openpond-agent run <action>` | trace JSONL, artifact index | action result JSON when `--json` is set | nonzero on action/load/runtime errors | local smoke, hosted action bridge |
| `openpond-agent traces --json` | none | trace listing JSON | nonzero on read errors | trace summary projection |

## Compatibility Rule

The inspect contract tests pin the JSON paths that source-edit checks, web, app, and publish flows may rely on. Platform consumers should add a new required path to the inspect-shape fixture before depending on it.
