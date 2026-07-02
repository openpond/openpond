# OpenPond Agent Validation Report

Schema: openpond.agent.validation.v1

Status: failed

## Summary

- Errors: 2
- Warnings: 4

## Errors

- [typescript_manifest_openpond_yaml_drift] openpond.yaml exists, but the TypeScript project does not explicitly extend it. (openpond.yaml)
- [env_name_required] Env/secret declaration requires a name. (env.name)

## Warnings

- [channel_missing_integration_requirement] Channel slack requires slack, but no matching integration is declared. (channels.slack.requiredConnections)
- [volume_used_by_action_missing] Volume state is marked usedBy missing action missing-action. (volumes.state.usedBy)
- [eval_expected_artifact_not_declared] Eval missing-artifact expects artifact artifacts/missing.json, but no action declares it. (evals.missing-artifact.expectedArtifacts)
- [skill_generated_file_path_invalid] Skill unsafe-skill generated file path must stay inside the skill package: ../outside.md (skills.unsafe-skill.files.../outside.md)
