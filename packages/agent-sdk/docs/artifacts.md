# Generated Artifacts

`openpond-agent build` writes deterministic artifacts under `.openpond` by default.

| Path | Schema |
| --- | --- |
| `.openpond/artifact-index.json` | `openpond.agent.artifact-index.v1` |
| `.openpond/agent-manifest.json` | `openpond.agent.manifest.v1` |
| `.openpond/action-registry.json` | `openpond.agent.action-registry.v1` |
| `.openpond/agent-inspect.json` | `openpond.agent.inspect.v1` |
| `.openpond/openpond-manifest.preview.yaml` | `openpond.runtime.manifest.v1` |
| `.openpond/runtime-bridge.mjs` | `openpond.agent.runtime-bridge.v1` |
| `.openpond/validator-report.md` | `openpond.agent.validation.v1` |
| `.openpond/prompts/instructions.md` | `openpond.agent.instructions.v1` via artifact index |
| `.openpond/skills/<skill>/SKILL.md` | `openpond.agent.skill.v1` via artifact index |
| `.openpond/eval-results.json` | `openpond.agent.eval-results.v1` |
| `.openpond/traces/*.jsonl` | `openpond.agent.trace.v1` per line |

`artifact-index.json` is the discovery file for generated outputs. It stores path, kind, format, and schema for static build artifacts and dynamic eval/run trace artifacts. `assertArtifactSchemaCompatibility` checks embedded schemas for JSON, JSONL, YAML, validator reports, and runtime bridge output.

`agent-manifest.json`, `agent-inspect.json`, and `openpond-manifest.preview.yaml` include source-declared `inputSchema` data when a project defines it. The runtime preview writes this to `inputs.schema` so platform create/run forms can use the same source-owned upload and input contract.

Generated artifacts are runtime contracts and previews. For TypeScript-first projects, source remains authoritative.
