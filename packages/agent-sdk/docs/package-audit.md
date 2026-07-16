# Package Audit

This audit records the package surfaces that must stay generic before platform and UI work depends on the SDK.

## Scope

- `package.json` keeps the package identity on `openpond-agent-sdk`, exposes only stable `dist` entrypoints, and keeps root scripts package-first.
- `src/` is organized by public surface and core implementation: commands, CLI parsing, primitives, runtime, workflow, channels, instructions, skills, integrations, volumes, schedules, eval, tracing, validator, manifest, schemas, and editable policy.
- `templates/` contains source-backed starter projects for blank, customer-reply, and integration-heavy agents.
- `examples/` contains blank, customer-reply, water-estimator, integration-heavy, and negative-validation examples without making any one pilot the package identity.
- `docs/` contains public API, authoring, CLI, machine-output, artifact, validation, tracing/eval, template, migration, feature-matrix, platform-boundary, negative-validation, and package-audit references.
- `scripts/` owns build, example matrix, packed-install acceptance, and hygiene checks.
- `test/` owns focused contract suites for primitives, source loading, channels, runtime, artifacts, validation issues, pilot examples, platform inspect compatibility, and negative validation.
- Generated `.openpond` outputs in examples are created by package commands and checked for required artifacts.
- `dist/` is regenerated from `src/` and is the only package runtime surface shipped by `npm pack`.

## Audit Checks

The enforced audit command is:

```bash
pnpm check
```

That command proves:

- Build output and declaration files are generated before checks run.
- TypeScript source typechecks without platform-only imports.
- Focused tests cover public primitives, source loading modes, channel behavior, runtime spans, artifact schemas, validation issue codes, pilot examples, inspect shape, and negative validation examples.
- The example matrix runs inspect, build, validate, eval, run, and traces for all pilots and compares repeated build output for deterministic generated artifacts.
- The packed-install check imports every public subpath from the packed package, runs the installed CLI, verifies custom `--out-dir`, initializes templates, and runs all pilots from the packed dependency.
- Hygiene rejects example-specific package identity, private SDK imports from examples, populated hand-authored `src/actions` wrappers, missing docs, missing tests, large files, missing generated artifacts, and real secret patterns.
- `npm pack --dry-run` includes `dist`, docs, templates, README, and package metadata without source-only runtime dependencies.

## Current Verdict

The package is generic enough for the next platform phase when `pnpm check` passes from the Agent SDK package root.

Remaining non-SDK work stays platform-owned: integration lease selection, secret storage, volume provisioning, schedule enablement, run history, draft source refs, publish transactions, UI projections, and staging deployment.
