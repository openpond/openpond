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

Authored aggregation is declared by `taskset.metrics` in the shared Evals
contract. A custom metric's module must appear once in the package at its
declared path, retain private visibility, match its content hash and stay within
the 512 KiB source limit. Imports and owned revisions preserve that policy.
Evaluations use the shared isolated executor and retain its named result
separately from ordinary mean-score accounting.

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

## Revising an ordinary package

SDK `0.3.1` exposes `resolveTasksetPackageInstructions` from
`openpond-sdk/taskset-packages`. It reads the admitted Model or learning
definition for bound packages and `taskset.metadata.ordinaryAuthoring.instructions`
for ordinary packages. Ordinary authoring stores the objective in that hashed
metadata so import, execution and later revisions use the same instructions.
An omitted ordinary instruction is an empty package-wide prompt; a display name
is never substituted. Individual task inputs may contain their own instructions.

SDK `0.3.0` adds ordinary package authoring and requires Evals `0.9.0` for
authored metric policies. JavaScript packages must include a complete private
execution graph: ordinary packages carry `environment/execution.json`, while
bound packages retain their declared Model execution resources. A JavaScript
entrypoint alone no longer passes package validation. Use
`createTasksetPackageExecutionFile` to serialize the declaration, include every
referenced module/schema/state file, and call `validateTasksetPackage` before
publication. Existing immutable packages must be revised to add missing assets;
do not overwrite files retained by historical runs.

The browser-safe `openpond-sdk/model-taskset-authoring` entry point also exports
`TasksetDraftFileInfoSchema`, `TasksetDraftFileSchema`, and
`TasksetDraftFileMutationSchema`. File mutations carry the draft revision and
the prior file hash (`null` for a new file). A null content deletes a file;
otherwise content uses UTF-8 text or canonical base64. Hosts must authorize the
draft, serialize mutations against form saves/publication/deletion, reject stale
versions, and protect generated manifests and retained source history. Desktop
currently supports editing files up to 6 MB; larger dependencies remain listed
and are preserved in packages.

`openpond-sdk/model-taskset-authoring` exposes the draft request, preparation,
and ownership schemas for editors. Server helpers `prepareModelTasksetDraft`
and `publishModelTasksetDraftPackage` are exported from
`openpond-sdk/taskset-packages`.

Preparation pins a complete source package hash, an operation ID and the expected
Model revision. The host authorizes the selected Model/package and resolves its
canonical owner before calling the helper. Persist the returned preparation and
request hash before copying files into the draft workspace; a reused operation
with different input must conflict. A matching portable Model ID alone does not
establish a cross-workspace ownership link.

The first revision forks a shared source into an owned identity. Subsequent
revisions retain that identity and record the exact parent. Publication accepts
a validated edited package, preserves its binary/private files and execution
environment, and seals its owned Taskset and verifier set. Qualification,
privacy attestations and verifier calibration for different bytes are cleared;
authored fixtures remain available to run again. Package validation checks the
declared identity and parent lineage.

Ordinary JavaScript environments carry a private `environment/execution.json`
declaration created with `createTasksetPackageExecutionFile`. It binds the
environment release, verifier set and JavaScript definition to the module and
each task's private initial state. `validateTasksetPackage` verifies this graph;
`resolveTasksetPackageExecution` returns its verified text assets for an
authorized execution host. Bound packages retain their existing execution
resource graph. Publication regenerates the ordinary declaration when it seals
the owned verifier set. Local file authoring also pins changed module bytes and
reseals the environment before publication, while historical revisions keep
their original executable files.

These pure helpers require the host to persist draft files and commit publication,
Model selection and retry receipts atomically. Bound Reward packages use the same
draft workflow with `authoringGraph: "bound"` in their retained preparation.
Pass the original `source` package to `publishModelTasksetDraftPackage` or
`compileModelTasksetDraftWorkspace` for these drafts. Task edits preserve the
exact saved Reward, task format and private dependency graph; changing graders
requires publishing/selecting a Reward through its own editor. Unchanged
environment execution retains its release. Publication creates an owned revision
and clears package qualification; it never changes the original source. Reviewed
batches still require their review/regrading workflow.

`bindOrdinaryModelTasksetReward({ owner, source, rewardBinding, rewards, assets })`
prepares a complete model-owned package when a user selects a saved Reward for an
ordinary collection. The source must include collection instructions. This keeps
task envelopes, per-task output contracts, binary files, private context and tools
intact. Its model resources explicitly declare `instructionMode: "per_task"` so
task-specific context is preserved independently of the collection instruction.
The selected Reward's private assets must resolve exactly. Hosts commit the new
package and Model selection with their CAS and retry receipt, regenerate stale
recipes, and advance an evaluation selection that referred to the edited source.
An independently selected evaluation package remains pinned.

## Shared draft documents and compilation

`openpond-sdk/taskset-drafts` exports the complete `TasksetDraftSchema`, the
authoring validator and the immutable `TasksetDraftWorkspaceSchema`. Desktop
imports these same contracts and authoring functions. A workspace contains one
draft document and hashed source files; managed form manifests are synthesized
from the document instead of stored as a second editable copy.

Use `saveTasksetDraftWorkspaceDocument` for form edits and
`saveTasksetDraftWorkspaceFile` for file edits. Both require the expected draft
revision and return a new workspace. File edits also compare the previous file
hash, preserve exact UTF-8/base64 bytes and reject managed manifests or retained
source archives. Published workspaces cannot be edited. The JSON workspace is
limited to 64 MiB; editable file content is limited to 6 MB.

Server-side package helpers are exported from `openpond-sdk/taskset-packages`:

```ts
const projected = prepareImportedTasksetPackage({
  package: source, profileId: owner.scopeId, name, createdAt: now,
});
const initialized = prepareTasksetDraftSource({
  source, preparation, expectedModelRevision,
  sourceDraft: tasksetDraftFromTaskset(projected.taskset, now),
});
const workspace = materializeTasksetDraftWorkspace({ initialized, source });
const publishedPackage = compileModelTasksetDraftWorkspace({
  workspace, preparation, adapterId: "my-authoring-host", now,
});
```

`tasksetDraftFromTaskset` is exported from `openpond-sdk/taskset-drafts`.
Retain the original `preparation` and source package before initialization.
Compilation verifies that preparation, applies the same publication validation
as Desktop, pins changed code and private assets, and seals an owned package.
It does not execute a model, run graders, select a Taskset or commit host state.
Imported source still requires explicit source review before publication.

## Hosted draft client contract

`OpenPondTasksetDraftClient` from `openpond-sdk/taskset-drafts` defines the
scoped `/v1/models/:modelId/taskset-drafts` protocol. Construct it in server code
with `baseUrl`, `apiKey` and `teamId`. It supports source inspection,
initialization, listing, document/file reads and edits, explicit Model refresh,
validation, publication and deletion. Hosting these endpoints requires a server
implementation; exporting this client alone does not make them available.

Validation pins the exact draft revision and workspace hash and returns the
compiled package hash and Taskset reference. Publication requires those same
values plus an operation ID. The host must atomically compare the draft and
Model revisions, publish/select the package, finalize the draft and retain the
retry receipt. The client verifies response scope, revisions and file hashes;
it never retries writes automatically. Hosts own authorization, durable storage,
pagination, transaction isolation and idempotent recovery.

### Publish a Model with retained evaluation

When synchronizing a local Model, publish its complete evaluation Taskset alongside
its training package using `evaluationPackage` and `modelConfiguration`. Set
`modelConfiguration.trainingSetup.evaluationTasksetRef` to the evaluation package's
portable Taskset release identity, not the local Taskset identity. The publication
receipt includes `evaluation.taskset`, `evaluation.packageHash` and
`evaluation.hostedTasksetId`; the SDK rejects a missing or mismatched receipt.

The same configuration carries the saved recipe and limits. Publication does not
run training or prove evaluation isolation, grader quality or training readiness.
An attachment-only publication cannot change Model configuration.

For a new collection without a source release, call `client.create` with
`schemaVersion: "openpond.tasksetDraftCreate.v1"`, an operation ID, Model ID,
expected Model revision and name. Retain the operation ID across retries. The
host creates an empty owned draft using the same save, file, validation and
publication lifecycle. It must not add example tasks or a judge rubric.
`compileModelTasksetDraftWorkspace` accepts `preparation: null` only when the
owned draft has no source preparation. Compilation pins the saved timestamp so
validation and publication produce the same package hash.

## Individual task inventory

`openpond-sdk/taskset-drafts` exports `TaskInventoryQuerySchema`,
`TaskInventoryItemSchema`, `TaskInventoryPageSchema`, and the corresponding
types. The inventory presents individual tasks; collections remain revisioned
authoring and filtering boundaries. Public descriptions and scoring summaries
are separate from private detail readbacks.

The local runtime exposes `GET /v1/training/tasks` and
`GET /v1/training/tasks/detail`, scoped by `profileId` and optional `projectId`.
Use `tasksetId`, `taskId`, `draftId`, `split`, and `query` to narrow a view. Pages
contain at most 100 rows. Pass `nextCursor` back as `after`; a cursor is rejected
when its filters, Profile, Model, or indexed source versions change. A detail
request requires `tasksetId` and `taskId`; include `draftId` for draft tasks.

Local indexes are rebuilt from saved source bytes per content hash, including
Parquet collections through the dataset reader. Search never examines private
answers. Draft edits invalidate the index, and a published release remains
separate from its draft. No task listing, editing, or labeling operation starts
a training job.
