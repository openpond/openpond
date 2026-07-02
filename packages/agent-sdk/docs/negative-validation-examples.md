# Negative Validation Examples

`examples/validation-failures` is an intentionally invalid package-level example. It is not part of the happy-path example matrix because its purpose is to fail validation and eval checks.

It covers these states:

- Missing integration setup: Slack channel requires `slack`, but no matching integration is declared.
- Missing env/secret refs: the example declares a required `OPENAI_API_KEY` slot for platform secret binding, and also includes an invalid empty env declaration to prove SDK validation.
- Missing volume binding representation: the `state` volume uses `select-or-create` policy and includes an invalid `usedBy` action to prove warning output; platform deploy plans must still block when the required volume is unbound.
- Disabled schedule: the `daily-summary` schedule is declared with `enabledByDefault: false`, so platform setup should create it disabled until explicitly enabled.
- Manifest drift: a committed `openpond.yaml` exists while the TypeScript project uses `manifestMode: "typescript"`.
- Failed eval gate: the `fails-gate` eval expects text that the action does not return and has `publishGate: true`.
- Unsafe generated skill file: the generated skill declares a sibling path outside the skill package.

Run the example directly when testing negative behavior:

```bash
openpond-agent validate --json --cwd examples/validation-failures
openpond-agent eval --json --cwd examples/validation-failures
```

Expected validation issue codes include `typescript_manifest_openpond_yaml_drift`, `channel_missing_integration_requirement`, `env_name_required`, `volume_used_by_action_missing`, `skill_generated_file_path_invalid`, and `eval_expected_artifact_not_declared`.

Expected eval behavior: eval is blocked while validation errors exist. If the drift/env errors are fixed, the `fails-gate` eval should fail and produce a publish-gate failure.
