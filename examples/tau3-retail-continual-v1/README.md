# Tau3 Retail Continual Bench v1

This is a reproducible Continual Bench example derived from the Retail scenario
shape in Sierra's Tau3 work. It is named `tau3-retail-continual-v1`, not
`T3Bench-CL`: it is not an official Tau3 release or leaderboard.

The compact `source/tasks.jsonl` fixture is intentionally synthetic and ships
only to exercise conversion, validation, disclosure, statistics, and reporting
in CI. `golden-migration.json` separately records the exact public identities
and allocations of the v3 migration used to verify the generic package path.

## Reproduce

Upstream pin: `sierra-research/tau3` at
`a2c024725189473d2d7cea3a5cfdbcc67478e41f`.

```bash
openpond bench init \
  --from ./source/tasks.jsonl \
  --output ./continual-bench.yaml \
  --id tau3-retail-continual-v1 \
  --name "Tau3 Retail Continual Bench v1" \
  --license MIT \
  --repository https://github.com/sierra-research/tau3 \
  --commit a2c024725189473d2d7cea3a5cfdbcc67478e41f \
  --seed tau3-retail-continual-v1-public-fixture \
  --non-interactive

openpond bench validate ./continual-bench.yaml
pnpm tsx ./verify.ts
```

To execute, add an `execution` binding for an existing OpenPond Model Project
and immutable Taskset releases, validate again, then run:

```bash
openpond bench run ./continual-bench.yaml
```

That command creates and seals the normal Comparison Series. It does not queue
or start a release. Local validation never uploads the sibling or frozen rows,
and the runner cannot expose them to the optimizer before their declared phase.

## Contents

- `continual-bench.yaml`: generated sealed portable manifest.
- `continual-bench.json`: the identical machine-readable manifest used by CI.
- `source/tasks.jsonl`: redistributable compact fixture.
- `golden-migration.json`: exact production-depth split and allocation fixture.
- `fixture-report.json`: deterministic receipt-shaped scorecard used by docs.
- `verify.ts`: CI verification for hashes, allocations, validation, and report.
- `UPSTREAM-LICENSE`: upstream MIT notice and attribution.

Results produced from this example are Continual Bench results. They are not an
official Tau3 leaderboard submission and OpenPond is not affiliated with or
endorsed by Sierra.
