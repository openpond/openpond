# CLI Machine Output

Machine-readable command output is part of the platform contract. Use `--json` where available and consume generated artifact paths from `.openpond/artifact-index.json` when possible.

## `openpond-agent inspect --json`

- Writes: `.openpond/agent-inspect.json`
- Prints: inspect JSON
- Exit code: nonzero on source load errors
- Stable consumers: source-edit policy discovery, web/app projections, publish checks
- Required shape: pinned by the inspect-shape fixture

## `openpond-agent validate --json`

- Writes: `.openpond/validator-report.md`
- Prints: validation JSON
- Exit code: `0` when there are no validation errors; nonzero when `errors.length > 0`
- Stable consumers: deploy plan, source-check status, publish blocking UI
- Important fields: `schema`, `status`, `summary`, `issues[]`, `errors[]`, `warnings[]`

Warnings are allowed to block publish only when the platform chooses to enforce them as policy. Errors always block eval and publish.

## `openpond-agent eval --json`

- Writes: `.openpond/eval-results.json`, trace JSONL files, `.openpond/artifact-index.json`
- Prints: eval results JSON
- Exit code: `0` only when all evals pass; nonzero when any eval fails
- Stable consumers: source checks, publish gates, eval summaries
- Important fields: `summary`, `publishGate`, `results[].traceArtifactRef`, `results[].assertions`

## `openpond-agent run <action> --json`

- Writes: trace JSONL files and `.openpond/artifact-index.json`
- Prints: action result JSON
- Exit code: nonzero on source load, validation, missing action, timeout, cancellation, or action failure
- Stable consumers: local smoke tests and hosted runtime bridge

## `openpond-agent traces --json`

- Writes: no new artifacts
- Prints: trace listing JSON
- Exit code: `0` with an empty listing when no trace directory exists; nonzero only for invalid arguments or process failures
- Stable consumers: trace summary projection and local debugging

## Text-Only Commands

`openpond-agent init` and `openpond-agent build` currently print text. `build` writes machine-readable artifacts and the artifact index; callers should read the artifacts rather than parse the text output.

## Exit-Code Policy

- `0`: command completed and any relevant required checks passed.
- Nonzero: source load failure, validation error, eval failure, missing action, runtime failure, or invalid arguments.
- JSON may still be printed for failed validation/eval commands; callers should use both exit code and `status` fields.
