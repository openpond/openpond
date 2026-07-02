# Validation

`openpond-agent validate --json` returns a stable machine-readable report:

```json
{
  "schema": "openpond.agent.validation.v1",
  "status": "failed",
  "summary": { "errors": 1, "warnings": 0 },
  "issues": []
}
```

Each issue includes `code`, `severity`, `message`, `summary`, optional `path`, optional `source`, optional `setupRequirement`, and optional `details`.

## Issue Codes

- `project_name_required`
- `project_version_required`
- `agent_config_missing`
- `openpond_yaml_missing`
- `typescript_manifest_openpond_yaml_drift`
- `extends_manifest_missing`
- `action_required`
- `action_duplicate`
- `action_target_workflow_missing`
- `default_action_missing`
- `intent_duplicate`
- `intent_default_missing`
- `channel_target_action_missing`
- `channel_missing_integration_requirement`
- `schedule_target_action_missing`
- `tool_target_action_missing`
- `tool_target_workflow_missing`
- `volume_used_by_action_missing`
- `eval_expected_artifact_not_declared`
- `env_name_required`
- `env_duplicate`
- `env_secret_value_inline`
- `editable_backend_invalid`
- `editable_allowed_paths_missing`
- `editable_required_checks_missing`
- `source_file_missing`
- `skill_description_missing`
- `skill_source_missing`
- `skill_generated_file_count_exceeded`
- `skill_generated_file_path_invalid`
- `secret_leakage_detected`

Warnings can still block publish later if platform policy treats the related setup requirement as required. Secret leakage and inline secret values are always errors.
