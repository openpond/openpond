# Agent Edit Check Status JSON

`openpond agent edit check-status <workItemId> --team-id <id>` and `openpond agent source check-status <workItemId> --team-id <id>` print JSON. `--json` is accepted for command-line consistency; the output shape is JSON either way.

The response is a compact projection for Builder Chat and source-check UI. It must not include raw hosted-process output, full runtime events, full work-item metadata, raw trace JSONL, raw eval result payloads, or secret values.

## Top-Level Shape

```json
{
  "workItem": {},
  "activity": [],
  "sourceCheckStatus": {}
}
```

- `workItem`: compact work-item summary with ids, status, ownership refs, latest task/runtime refs, source refs, and timestamps.
- `activity`: bounded compact activity entries. Activity payloads may contain compact setup, policy, check, trace, eval, patch, draft, or publish refs.
- `sourceCheckStatus`: normalized status object. The API should provide this field directly. If an older API omits it, the OpenPond CLI derives the same compact shape from `workItem` and `activity`.

## `sourceCheckStatus`

Stable fields:

- `workItemId`: work item id.
- `workItemStatus`: current compact work-item status.
- `latestTaskRunId`: latest coding-task run id, when known.
- `latestRuntimeId`: latest runtime id, when known.
- `sourceMaterialization`: compact source checkout/materialization status, including source ref or commit SHA when available.
- `sourceUploadMetadata`: compact source-upload contract for SDK-backed projects. Expected fields include `sourceTreeMode`, `commands`, `generatedManifestPath`, `synthesizedOpenPondYaml`, `openPondYamlMode`, `uploadMetadataPath`, `uploadMetadataHash`, `artifactHashes`, `dependencySetup`, and redacted setup-output refs. This field must not include raw setup stdout/stderr or secret values.
- `setup`: dependency setup status for SDK-backed edits. Expected fields include `status`, `passed`, `message`, `command`, `exitCode`, `commands`, `expectedBinaryPath`, and `dependencyPackages`.
- `policyDiscovery`: SDK policy-discovery status. Expected fields include `status`, `command`, `exitCode`, `durationMs`, `message`, and discovered `requiredChecks`.
- `discoveredRequiredChecks`: required check commands discovered from source.
- `checkRuns`: compact per-check results with command, status, pass/fail, exit code, duration, and artifact refs when available.
- `validation`: compact validation rollup.
- `eval`: compact eval rollup.
- `requestedCheckKind`: requested check kind such as `validate`, `eval`, `publish_review`, or `all`.
- `deployPlan`: compact deploy/publish readiness projection.
- `traceArtifactRefs`: trace artifact refs, not trace payloads.
- `evalResultArtifactRefs`: eval result artifact refs, not eval payloads.
- `validatorArtifactRefs`: validator report artifact refs.
- `patchArtifactRef`: patch artifact ref returned by the source-check run, when present.
- `draftSourceRef`: draft source ref, when present.
- `finalResultState`: latest terminal or review state for the source-check run.
- `publishBlockers`: compact publish blockers such as missing setup, stale source, stale manifest, failed checks, or missing source commit SHA.

Future source-check execution fields should be added under `sourceCheckStatus` or a nested compact object with task-run id, runtime id, source snapshot version, check bundle hash, and mismatch warnings. Clients should preserve unknown fields.

## Example

```json
{
  "sourceCheckStatus": {
    "workItemId": "work_item_test",
    "workItemStatus": "needs_review",
    "latestTaskRunId": "task_run_test",
    "latestRuntimeId": "runtime_test",
    "sourceMaterialization": {
      "status": "completed",
      "sourceCommitSha": "source_sha_test"
    },
    "sourceUploadMetadata": {
      "sourceTreeMode": "typescript_agent_sdk",
      "commands": {
        "inspect": "pnpm run agent:inspect",
        "build": "pnpm run agent:build",
        "validate": "pnpm run agent:validate",
        "eval": "pnpm run agent:eval"
      },
      "generatedManifestPath": ".openpond/openpond-manifest.preview.yaml",
      "synthesizedOpenPondYaml": true,
      "openPondYamlMode": "synthesized",
      "uploadMetadataPath": ".openpond/source-upload-metadata.json",
      "dependencySetup": {
        "required": true,
        "installCommand": "pnpm install --offline",
        "expectedBinaryPath": "node_modules/.bin/openpond-agent",
        "sdkPackage": {
          "path": ".openpond/vendor/openpond-agent-sdk.tgz"
        }
      }
    },
    "setup": {
      "status": "completed",
      "passed": true,
      "commands": ["pnpm install --offline"],
      "expectedBinaryPath": "node_modules/.bin/openpond-agent"
    },
    "policyDiscovery": {
      "status": "completed",
      "command": "openpond agent inspect --json",
      "requiredChecks": ["openpond agent validate", "openpond agent eval"]
    },
    "discoveredRequiredChecks": ["openpond agent validate", "openpond agent eval"],
    "checkRuns": [
      {
        "command": "openpond agent validate",
        "status": "passed",
        "passed": true
      }
    ],
    "validation": { "status": "passed", "passed": true },
    "eval": null,
    "requestedCheckKind": "validate",
    "deployPlan": {
      "status": "needs_validation",
      "canDeploy": false,
      "blockedReasons": ["source_commit_sha_missing"]
    },
    "traceArtifactRefs": ["artifacts/openpond-trace.jsonl"],
    "evalResultArtifactRefs": ["artifacts/openpond-eval-results.json"],
    "validatorArtifactRefs": ["artifacts/validator-report.json"],
    "patchArtifactRef": "openpond://coding-task-runs/task_run_test/patch",
    "draftSourceRef": null,
    "finalResultState": "completed",
    "publishBlockers": ["source_commit_sha_missing"]
  }
}
```

## Failure Classification

Status readers should distinguish setup, policy discovery, validation, eval, and publish blocking failures:

- dependency setup failure: `setup.status = "failed"` with redacted `message`, `command`, and `exitCode`.
- missing SDK binary or command resolution failure: `policyDiscovery.status = "failed"` before validation/eval fields pass.
- invalid inspect JSON: `policyDiscovery.status = "failed"` with a redacted parse/classification message.
- validation failure: `validation.status = "failed"` and a failed `checkRuns[]` entry.
- eval failure: `eval.status = "failed"` and eval artifact refs when available.
- publish blocker: `publishBlockers[]` and `deployPlan.blockedReasons[]` should explain why publish is not allowed.

Large logs, stdout/stderr, trace payloads, eval payloads, and secrets must remain in artifacts or backend logs, not in this JSON response.
