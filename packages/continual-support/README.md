# @openpond/continual-support

Runner-neutral primitives for continual model improvement.

The package defines sealed manifests and issue packets, deterministic
family-level splitting, leakage and prior-exposure validation, paired
statistics, receipt-derived reports, and a runner-adapter interface. It creates
ordinary OpenPond Comparison Series and does not introduce another Run
lifecycle.

```ts
import {
  createContinualBenchSplit,
  validateContinualBenchManifest,
} from "@openpond/continual-support";
```

The CLI workflow is:

```text
openpond continual init --from ./tasks.jsonl
openpond continual validate ./continual-support.yaml
openpond continual run ./continual-support.yaml
openpond continual report <comparison-series-id>
```

`validate` is local. It does not make a network request or upload hidden rows.
`run` creates and seals a normal Comparison Series, then stops: queueing and
starting remain explicit operator actions.

The package intentionally contains no scenario-owned tasks, graders, migration
fixtures, or dataset adapters. Those belong to user Taskset packages.

## API map

| Surface | Primary exports |
| --- | --- |
| Manifests | `ContinualBenchPortableManifestSchema`, `sealPortableManifest`, `verifyPortableManifest` |
| Issue packets | `ContinualBenchIssuePacketSchema`, `sealIssuePacket`, `verifyIssuePacket` |
| Splitting | `createContinualBenchSplit`, `createContinualBenchPanelAllocations`, `correctionPanelIdsForSchedule` |
| Validation | `validateContinualBenchManifest`, `auditContinualBenchLeakage`, `auditPriorExposure`, `assertOptimizerIsolation` |
| Metrics | `ContinualBenchAttemptMetricSchema`, `ContinualBenchTaskMetricSchema`, `ContinualBenchEfficiencyMetricSchema` |
| Statistics | `pairedBootstrapEstimate` |
| Reports | `ContinualBenchPortableReportSchema`, `createContinualBenchReport`, `exportContinualBenchReport` |
| Execution | `ContinualBenchRunnerAdapter`, `createOpenPondContinualBenchAdapter`, `disclosedPanels`, `optimizerTasksForPass` |

The current `ContinualBench*` TypeScript names and wire-schema identifiers are
protocol-level compatibility names; product surfaces call the capability
Continual Support.

## Compatibility and privacy

The portable manifest can be consumed by another runner. OpenPond-specific
bindings live in the optional `execution` block. The package contains no
provider credentials, private hosting details, or hidden task contents.

Sibling-verification and frozen-final tasks remain unavailable to optimizer
adapters until their declared disclosure phase. Validators reject any task
that is both optimizer eligible and held out.

## License

MIT.
