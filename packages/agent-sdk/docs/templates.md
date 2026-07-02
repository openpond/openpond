# Templates And Examples

Packaged templates are copied with `openpond-agent init`.

## Templates

- `blank-agent`: minimal OpenPond Chat agent with one intent, one skill, one eval, and edit policy.
- `customer-reply-agent`: small customer reply agent with optional Slack setup.
- `integration-heavy-agent`: setup-heavy template with Slack, model access, env/secret refs, a project volume, a disabled schedule, artifacts, evals, and edit policy.

## Examples

- `examples/blank-agent`: raw no-template path.
- `examples/customer-reply-agent`: small first-party template path.
- `examples/water-estimator-agent`: complex workflow path with actions, workflows, tools, integrations, volumes, channels, schedules, artifacts, evals, and editable policy.
- `examples/integration-heavy-agent`: setup-heavy path with required/optional setup slots, volumes, schedules, artifacts, evals, and edit policy.

Examples must import public SDK subpaths only. They should not rely on private `src/*` internals, root-only scripts, real secrets, or platform-only setup that is not declared in source.

`scripts/check-examples.ts` runs inspect, build, validate, eval, run, and traces across examples. `scripts/check-package-install.ts` packs the SDK, installs it into external fixtures, initializes templates, and verifies package-installed execution.
