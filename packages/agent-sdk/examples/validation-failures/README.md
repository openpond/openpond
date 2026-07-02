# Validation Failures Example

This folder is intentionally not part of the happy-path example matrix. It contains package-level negative examples for validation and publish-gate behavior.

## Invalid Source Contract

Run:

```bash
openpond-agent validate --json --cwd examples/validation-failures
```

Expected issue coverage:

- `typescript_manifest_openpond_yaml_drift`
- `channel_missing_integration_requirement`
- `env_name_required`
- `volume_used_by_action_missing`
- `skill_generated_file_path_invalid`
- `eval_expected_artifact_not_declared`

It also declares a required `OPENAI_API_KEY` env/secret slot, a `select-or-create` volume, and a disabled schedule so platform deploy-plan code can project missing secret, missing volume binding, and disabled schedule setup states.

## Eval Gate Failure

Run:

```bash
openpond-agent eval --json --cwd examples/validation-failures/eval-gate
```

Expected behavior:

- validation passes
- eval result status is `failed`
- publish gate status is `failed`
- `fails-gate` appears in `publishGate.blockingFailures`

These examples use only public package imports and should remain small enough to inspect by hand.
