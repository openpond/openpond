# Profile and Agent Layout

`get_profile` owns absolute path authority. Use this reference only for relative structure beneath the returned Profile source.

```text
openpond-profile.json
profiles/<profile>/
  settings/profile.yaml
  workflows/catalog.json
  agents/<agent-id>/
    package.json
    tsconfig.json
    agent/
      agent.ts
      instructions.md
      actions/
      workflows/
      tools/
      connections/
      channels/
      evals/
    src/
    .openpond/
```

The exact repository may contain a different selected Profile layout. Read its manifest and neighboring packages before writing. Register a new Agent through the same manifest/settings convention already used by that Profile.

Source belongs in the Agent package. SDK-generated manifests, action registries, inspection output, eval results, traces, and artifact indexes belong under `.openpond/` and should be refreshed through the SDK rather than hand-authored.

Reusable Profile Work workflows belong in `profiles/<profile>/workflows/catalog.json`.
They name stable workflow IDs, JSON input schemas, released instructions or
typed runtime actions, and enabled Skill paths. This catalog is distinct from
an Agent package's internal `agent/workflows/`. Commit it with the Profile;
the server validates it and returns exact release bindings through
`GET /v1/profile/workflows`. Keep evaluation definitions under `evals/` and
outside model-visible workflow instructions.

An improve target is exact authority. Never fall back to the default Agent, a similarly named directory, or another Profile.
