# @openpond/continual-bench

Portable, runner-neutral primitives for continual-learning benchmarks.

The package defines sealed manifests and issue packets, deterministic
family-level splitting, exact/family/similarity/prior-exposure validation,
paired statistics, receipt-derived report exports, and a runner-adapter
interface. Its first adapter creates and seals an ordinary OpenPond Comparison
Series; it does not define another Run lifecycle.

```ts
import {
  createContinualBenchSplit,
  validateContinualBenchManifest,
} from "@openpond/continual-bench";
```

The CLI workflow is:

```text
openpond bench init --from ./tasks.jsonl
openpond bench validate ./continual-bench.yaml
openpond bench run ./continual-bench.yaml
openpond bench report <comparison-series-id>
```

`validate` is local. It does not make a network request or upload hidden rows.
`run` creates and seals a normal Comparison Series, then stops: queueing and
starting remain explicit operator actions.

See [`examples/tau3-retail-continual-v1`](../../examples/tau3-retail-continual-v1)
for a versioned fixture, migration hashes, and complete reproduction steps.

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
| Migration | `CONTINUAL_BENCH_PREDECESSOR_COMMAND_INVENTORY`, `verifyGoldenMigrationFixture` |
| Scenario adapter | `canonicalizeTau3RetailOwnership` from `@openpond/continual-bench/adapters/tau3-retail` |

All public records use strict Zod schemas. Sealed records use canonical,
key-sorted JSON and SHA-256 content hashes. The `./schema`, `./manifest`,
`./report`, and `./adapters/tau3-retail` export paths are stable package entry
points in v0.2.

## Compatibility and privacy

The portable manifest can be consumed by another runner. OpenPond-specific
bindings live in the optional `execution` block. The package contains no
provider credentials, private hosting details, or hidden task contents.

Sibling-verification and frozen-final tasks remain unavailable to optimizer
adapters until their declared disclosure phase. Validators reject any task
that is both optimizer eligible and held out.

## License

MIT. Examples retain their upstream notices.
