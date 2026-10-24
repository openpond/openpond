# Ponder TypeScript SDK

`ponder-sdk` exposes the complete public `openpond-sdk` API through generated
JavaScript and TypeScript re-exports. Both distributions use the same version;
Ponder depends on that **exact** OpenPond release. There is one implementation.

```ts
import { createTrainingClient } from "ponder-sdk/training";
import { OpenPondLearningClient } from "ponder-sdk/learning";
```

Every current public subpath is mirrored, including browser-safe contracts.
The root package metadata describes Ponder itself. Python `ponder_sdk` is a
separate training/evaluation/learning client; shared naming does not imply that
all TypeScript sandbox/commerce APIs are available in Python.

## Release and external-consumer qualification

Run the existing `pnpm release:sdk:patch` (or minor/major) preparation flow from
a clean, current `master`. It updates the source SDK, Ponder version and exact
dependency together. The added dependency change deliberately uses ordinary CI.
No separate Ponder version bump is supported.

`pnpm ponder-sdk:check` generates re-exports, packs **both** distributions and
installs them in a temporary external consumer. It compares all runtime export
keys and reference identities, and, with explicit `--declarations`, compiles bidirectional namespace assignments
for every public entrypoint with the repository's serialized compiler runner.
The local default is runtime-only. The release workflow uses
`--registry-dependency --declarations` to install the actual published exact
OpenPond dependency rather than substituting a local source tarball.
`--local-dependencies` on the consumer script also packs the matching Evals and
Harness cohort for prepublication verification. This does not publish anything.
The source SDK's existing consumer check remains responsible for its browser,
runtime-file, protocol and declaration boundaries.

Publication is held until the intended npm account/organization controls the
name and the `npm-production` trusted publisher is configured for
`release-ponder-sdk.yml`. A public 404 is not ownership proof. The first release
requires the normal npm bootstrap with the reviewed tarball/version and publisher;
the workflow refuses automatic first publication. Do not run `npm publish` merely
to test name availability.

After bootstrap, `release-sdk.yml` publishes OpenPond and
`release-ponder-sdk.yml` independently waits for the exact source version before
publishing Ponder with provenance. A partial publication does not roll back or
republish the other name: inspect `npm view <name>@<version> dist.integrity`,
retain the successful artifact receipt, and dispatch only the missing workflow
on the same reviewed commit. Existing-version reconciliation creates the missing
tag/release without attempting another publication. A tag without its npm
version is refused as ambiguous. Registry availability, package ownership and
actual packed-consumer results are release gates, not source-review claims.

See the source SDK's [training workflow guide](../sdk/TRAINING_WORKFLOWS.md).
