# Migration Notes

## TypeScript-First Projects

Use `agent/agent.ts` and `manifestMode: "typescript"`. The SDK compiles source into `.openpond/agent-manifest.json`, `.openpond/action-registry.json`, and `.openpond/openpond-manifest.preview.yaml`.

Do not check in a root `openpond.yaml` unless the project explicitly extends it. If both files exist without extension mode, validation emits `typescript_manifest_openpond_yaml_drift`.

## Existing `openpond.yaml` Projects

Projects with only `openpond.yaml` can be inspected and built as `manifestMode: "openpond-yaml"`. This keeps the language-neutral runtime manifest path valid for non-TypeScript projects and migration fixtures.

## Extending `openpond.yaml`

Set:

```ts
manifestMode: "extends-openpond-yaml",
extendsManifest: "./openpond.yaml"
```

Use this when a TypeScript project intentionally composes with an existing manifest during migration.

## Future SDKs

Python and Rust SDKs should target the same generated manifest, inspect JSON, artifact index, trace JSONL, validation report, and eval result schemas. The control plane should consume those generated contracts instead of language-specific source files.
