# Offline Harness signal checks

`openpond experiments signal-plan` and `signal-report` use retained local Experiment files. They do not contact a server, invoke models, authenticate, or start training. Use the ordinary CLI to prepare the Harness Experiment and export its exact compiled dataset package and result.

Create the plan **before** executing the prepared request. Select development tasks with `split: train`, group attempts for the same prompt with distinct seeds, and use at least two independent `clusterKey` families. The package and prepared request must agree on taskset/package hashes. Every selected grader must be an exact package grader with positive weight, reward eligibility and no hard gate. This version requires unmapped grader inputs and rejects field mappings; criterion task hashes must match the frozen prompt. Version the family/exposure ledger separately: a hash cannot establish real-world independence.

For example, save `signal-input.json` with explicit reviewed thresholds:

```json
{
  "packageFile": "package.json",
  "preparationFile": "preparation.json",
  "thresholds": {
    "groupSize": 8,
    "minimumFamilies": 3,
    "minimumInformativeFamilies": 2,
    "minimumSpread": 0.1,
    "minimumScoredFraction": 0.95
  }
}
```

These numbers are illustrative review choices, not universal training criteria. `package.json` contains the compiled `openpond.tasksetPackage.v1` value (the `package` property of `datasets package --local`); `preparation.json` contains the `PreparedHarnessExperiment` value from `experiments prepare-harness --local`. Paths resolve relative to the input file. The preparation must already contain the complete repeated-seed population and intended sampling configuration. Freeze new plans whenever source, package, model, graders, population or thresholds change.

```sh
openpond experiments signal-plan --input-file signal-input.json --json > signal-plan.json
```

Retain the file unchanged. After the separately authorized local Experiment completes, obtain `experiments result RUN_ID --local --team TEAM_ID --json > result.json`. Save `report-input.json`:

```json
{"planFile":"signal-plan.json","resultFile":"result.json"}
```

```sh
openpond experiments signal-report --input-file report-input.json --json > signal-report.json
```

The report verifies the frozen request, budget, package, graders, complete case population, native model/source/output evidence and retained score aggregation. It reports per-prompt combined and component distributions, eligible fraction, constant groups, duplicate output counts and informative source families. Missing, unscorable and failed attempts remain in the denominator. It checks that criteria share an evidence hash, but the result export alone cannot reconstruct that hash without full trace/artifact data. It cannot mistake different constant rewards on different prompts for within-prompt signal. Unsettled cost or local cleanup blocks a positive signal result.

`signalObserved` means the supplied evidence passes this narrow signal check. `trainingAuthorized` and `runtimeParityVerified` remain false. Independently qualify reference answers, grader fixtures, approved pricing, actual learner weights/tokenizer/runtime, context limits, no-update execution, unchanged-parent noise and provider retirement before GRPO. A normal hosted gateway Experiment cannot establish the original GPU learner's parity.

# Hosted training watch deadlines

The existing official hosted watcher accepts a deadline and a cleanup reserve:

```sh
openpond training hosted-watch JOB_ID --team-id TEAM_ID \
  --deadline-at 2026-10-14T02:00:00Z --cleanup-reserve-ms 180000 \
  --cleanup-timeout-ms 180000 --interval-ms 10000 --json
```

The timestamp must be in the future and leave the reserve. The watcher sends cancellation when the reserve begins, reconciles explicit stale-version conflicts against a fresh job read, and waits for a matching terminal job cleanup receipt. `--wait-for-cleanup` also requests receipt checking without an absolute execution deadline. Public `succeeded`, `failed` and `cancelled` are terminal states. Deadline failure means cleanup remains unverified. A job cleanup receipt does not prove retirement of shared physical GPU resources or account-wide zero spend. The watcher must remain running to enforce its deadline; it is not a durable server scheduler.
