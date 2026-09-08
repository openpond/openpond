# Published Taskset inventory

`openpond-sdk/taskset-catalog` provides authenticated, paginated metadata reads
for the selected hosted workspace. The service applies workspace access and
optional Model Project attachment filtering before returning records.

```ts
import { OpenPondTasksetCatalogClient } from "openpond-sdk/taskset-catalog";

const tasksets = new OpenPondTasksetCatalogClient({
  baseUrl: "https://api.openpond.ai",
  apiKey,
  teamId,
});
const page = await tasksets.list({ limit: 30, modelProjectId });
const item = await tasksets.get(page.items[0].id);
const selected = await tasksets.resolve(item.release);
const next = page.nextCursor
  ? await tasksets.list({ limit: 30, modelProjectId, afterId: page.nextCursor })
  : null;
```

The item's `id` is the hosted inventory identity. Its `release` pins the portable
ID, revision and content hash used in model configuration. Metadata reads contain
no task rows, private verifier source or object-store locations. Publication and
package byte counts do not establish grading or training readiness.

The client rejects responses for a different workspace or requested resource,
limits catalog responses to 4 MiB, supports abort signals, and does not follow
redirects with credentials. `OpenPondTasksetCatalogError` preserves HTTP status and
the service's error code.

## Complete private packages

`openpond-sdk/taskset-packages` exports `createTasksetPackage`,
`validateTasksetPackage`, `decodeTasksetPackageFile`, and
`OpenPondTasksetPackageClient`. A package carries the exact Taskset, Environment
and Verifier Set releases, binary files encoded as canonical base64, and the
complete model resource graph when the Taskset declares a model binding.

Reviewed learning batches instead carry `learningResources`: the sealed batch,
exact evidence and admission decisions, source snapshots, and Reward source
assets. Validation recompiles the batch and checks its tasks, execution policy,
and private context files against those snapshots. These are portable review
records; importing a package does not enable an intake source, issue credentials,
or grant training approval in the receiving workspace. Local import and grading
can use the package without contacting a hosted service.

Validation verifies release hashes, dependency references, file bytes and
visibility. The package content hash seals the whole graph, including files
outside the Taskset manifest. The 64 MiB limit includes the JSON envelope and
base64 encoding. Validation does not establish execution readiness or authorize
access to private resources.

The client defines authenticated `POST /v1/taskset-packages` publication and
`GET /v1/taskset-packages/{model}/{taskset}/{revision}/{hash}` readback. These
operations require a host that implements the package protocol; availability
must be verified before enabling a hosted transfer flow.

Callers retain the publication's operation ID and expected project ETag across
retries. A successful receipt binds the operation, workspace, Model, Taskset
release, complete package hash and resulting project ETag. Pass its `packageHash`
as `get`'s `expectedPackageHash` to pin readback to that publication. The client
checks response ownership and release identity, rejects credential redirects,
and bounds streamed response bytes. Hosts must authorize Model access, enforce
immutable release-to-package mappings, and commit attachment and operation
receipts atomically with the project revision check.

To create or update a Model and select its package in one commit, supply
`selection: "select"` and `modelConfiguration`. The configuration includes the
portable Model ID, editable name/objective/defaults, source revision/timestamp,
and training setup without package-owned Taskset/Reward references or a prepared
recipe. The host derives those references from the validated package and returns
the committed Model summary in `receipt.project`. The client verifies that the
summary retains the requested configuration. Initial creation uses a null
expected ETag; later writes compare against the last saved hosted ETag.

Use `selection: "attach"` for a historical or comparison package. This requires
an existing Model and expected ETag, disallows `modelConfiguration`, and must
leave the selected configuration and ETag unchanged. The client verifies the
selection mode and unchanged ETag in the attachment receipt.

Desktop links retain the canonical API origin as well as workspace and Model
identity. Each package mapping records both the local Taskset hash and portable
release/package hashes; Profile provenance makes these different identities.
Persist the exact publication intent and immutable package before sending it.
After an uncertain response, replay that intent before publishing later local
edits, then merge the recovered hosted receipt without reverting those edits.

## Revising an approved batch

Browser editors import schemas and types from `openpond-sdk/model-batch-review`.
Servers use `inspectModelBatchPackage` from `openpond-sdk/taskset-packages` to
validate the complete package and return its definition, binding, evidence, and
decisions without portable file bytes. The inspection includes the sealed package
hash. Full package validation and compilation remain on the server.

`ModelBatchReviewRequestSchema`, `findModelBatchReview`, and
`beginModelBatchReview` define explicit editing of a Model's selected reviewed
batch. The host runs these helpers inside its authorized workspace transaction,
checks the Model revision and selected Taskset reference, and verifies that the
supplied package belongs to that immutable selection. An operation ID identifies
one exact request; retries return the original receipt, while changed requests
with the same operation ID conflict.

The request can change task instructions, schemas, inputs, evaluator-only context,
expected answers, and the selected published Reward binding. The helper creates
a new definition, Reward graph, enabled direct source, and evidence with parent
references. Sources record the original Model, package, batch, and Reward binding
in `reviewOrigin`. Original source credentials and admission decisions are never
imported. Attempts receive new IDs so matching example/attempt IDs from different
parent sources remain distinct.

Previously approved targets become pending feedback proposals. Policy-visible
task changes clear the observed response because that response was produced for
the original task. New evidence needs fresh grading and review before sealing;
the helper does not attach a batch or start training. A host must separately
compare the Model revision when attaching the newly prepared batch.
