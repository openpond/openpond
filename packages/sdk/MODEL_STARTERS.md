# Model starter contracts

SDK 0.1.7 adds `openpond-sdk/model-starters` and `openpond-sdk/model-starter-catalog`.

A starter pins a Taskset, task definition, Reward binding, Reward releases and text assets by identity, revision and content hash. `validateResolvedModelStarter` checks the complete small-package graph, executable grader equivalence, task schemas, split isolation and preview selection. Reward source stays private to evaluation. Resolved small packages are limited to 16 MiB; large Tasksets require the manifest/shard path rather than increasing this limit.

Tool packages using `openpond.javascript-environment.v1` also supply an `execution` object containing `environment`, `verifierSet`, and `javascript` releases. Taskset execution references pin the environment and verifier set; `environment.metadata.javascriptEnvironment` pins the JavaScript definition by identity, revision, and hash. The environment contract, tool declarations and compiled graders must agree exactly across these resources. Each task's `privilegedContextRef` identifies an inventoried `host_private` JSON text asset containing its initial state. Validation verifies the module asset, all referenced environment schema assets, and bounded object state before creation. These environments have no network or connected-app capabilities.

Execution resources are resolved package data and are excluded from previews. Hosts must persist the verified closure with the task resources and load it for their execution adapter; package validation alone does not implement a host adapter or create runtime evidence. Initial state belongs to the environment owner and must never be copied into model messages. Model-written claims about state cannot replace owner-collected results.

SDK 0.1.11 adds `createModelStarterExecutionAsset`, `modelStarterExecutionAssetId`, and `resolveModelStarterExecutionAsset`. Store the generated private JSON asset alongside the starter dependencies in the same creation transaction. Its identity derives from the environment and verifier release references, so either host can retrieve it without copying private code into Taskset metadata. The authored-text 512 KiB bound applies to this small closure. Resolution verifies the source bytes and the complete execution graph against the caller's immutable Taskset context; hosts may hydrate only the selected immutable task rows and their referenced assets. This resource is configuration, not evidence that a tool call ran.

`ModelStarterToolFixtureScriptSchema` defines a bounded sequence of tool names and argument objects. Authored grader fixtures put this script in `metadata.toolScript`; fixture output remains the policy's final response. Hosts execute the script through the real environment and collect state before grading. The Desktop adapter persists these as fixture attempts with no model identity, preserving the distinction from model evaluation.

`OpenPondModelStarterCatalogClient` lists metadata with `list({ limit, afterId })` and retrieves an exact package with `resolve({ id, revision, contentHash })`. It authenticates requests with an API key and workspace, rejects redirects, bounds streamed responses and checks returned identities. The hosted catalog endpoint must be deployed before these methods can be used against an environment.

`previewModelStarter(package)` projects only selected non-frozen inputs and policy-visible context, format schemas, metadata and split counts. It excludes expected outputs, private context and verifier bytes. Selection and preview perform no creation operation.

`createModelStarterCreationRequest(intent)` prepares the final configuration:

```ts
import { createModelStarterCreationRequest } from "openpond-sdk/model-starters";

const request = await createModelStarterCreationRequest({
  profileId,
  modelId,
  name: "Invoice extractor",
  starter: { id: starter.id, revision: starter.revision, contentHash: starter.contentHash },
  startingModel: starter.startingModel,
  method: starter.defaultMethod,
});
```

Prepare the request on final confirmation and retain it for transport retries. The server must authorize the profile, resolve trusted catalog content, materialize immutable files and atomically save resources, model configuration and the original retry receipt. A stable operation ID alone does not implement server idempotency. Creation starts no model call or training job.

`prepareModelTrainingDefaults({ setup, package })` fills missing Run settings from a validated model Taskset package. It selects retained evaluation when the collection has validation or frozen-evaluation tasks, and prepares a GRPO recipe when the starting model and execution resources are pinned. Existing recipes and explicit evaluation selections are preserved. Hosts apply it after selecting the model-owned Taskset and Reward. These saved settings do not authorize execution: Run review still validates the exact task populations, runtime support and approved budget.

Evidence references are nullable pointers to actual verifier, baseline, training and evaluation results. Publication and package integrity do not qualify a starter or imply improvement. Continuous learning is a separate model workflow mode; it is not a starter category or comparison-run type.

The repository's invoice-extraction example authors 80 original synthetic text tasks and executes its verifier fixtures. Its baseline, training, evaluation and full product qualification remain pending. The local server includes preparation, atomic persistence and file-materialization adapters; catalog publication, route wiring and Desktop Get Started integration are separate delivery steps.

## Model-owned Taskset revisions

`deriveModelTaskset` compiles a new immutable Taskset from an exact source package
and selected Reward binding. `ModelTasksetPackageSchema` and
`validateModelTasksetPackage` validate task formats, private assets, executable
graders, definition references and pinned execution resources. A package is
independent of its catalog listing.

```ts
import { deriveModelTaskset } from "openpond-sdk/model-starters";

const derived = deriveModelTaskset({
  owner: { scopeId, modelId },
  source,
  rewardBinding: selectedBinding,
  rewards: selectedRewards,
  assets: resolvedPrivateAssets,
});
```

The host must authorize the owner and source before compilation. The first edit
creates a distinct model-owned identity; later edits to that owner's Taskset
retain its identity and advance its revision. Another owner's edit forks a new
identity. `metadata.modelTasksetDerivation` retains exact root and parent refs.
The compiler rebuilds the grader snapshot, verifier set and task definition;
it preserves task rows and the environment. Changed packages have no inherited
calibration receipts, qualification results or publisher privacy attestation.
Authored fixtures can be retained for checking again.

The result includes `executionResources` for text and tool packages. Persist
`createModelTasksetExecutionResourcesAsset(derived.executionResources)` with the
derived package. On another host, load that private asset using
`modelTasksetExecutionResourcesAssetId(taskset)` and validate it with
`resolveModelTasksetExecutionResourcesAsset(taskset, asset)` before another edit.
This preserves the exact environment and verifier set for text packages too. Tool
packages also include the updated private JavaScript `execution` closure; persist
`createModelStarterExecutionAsset(derived.execution)` with the new definition.
The Taskset's binding and embedded Reward snapshot must agree. A model-level
selection cannot override the published grader snapshot at execution time.

Compilation changes no model or storage. The host must materialize immutable
files first, then atomically commit the Taskset, dependencies, intended model
attachment/configuration, compare-and-set revision and original operation
receipt. Keep preparation state across uncertain outcomes. A lost model CAS
may leave unattached package files; it must not retarget a model or overwrite an
earlier package. Reusing an operation returns its original committed result.

## Hosted starter attempts

The `openpond-sdk/model-starter-attempts` subpath defines a durable, workspace-scoped attempt API. Create requests select an attached Model Project, exact Taskset release, task, environment seed and explicit policy. They never carry replacement task input, private state, verifier source or evaluator context. Reuse the same `operationId` for a transport retry; use a new identity for a new evaluation.

A `hosted_chat` policy selects a registered hosted chat model explicitly. Its snapshot records the provider configuration used for the attempt; it does not claim that a mutable provider alias identifies immutable weights or that the model is the project's starting model. A `fixture` policy selects an immutable authored script and has no model identity or provider requests. These are separate result kinds, and fixture success is not model qualification.

`OpenPondModelStarterAttemptsClient` exposes `create`, `list`, `get`, `cancel` and `result` at `/v1/model-starter-attempts`. Cancellation is a request: poll until the owner reports terminal status and cleanup. Inventory is a summary; result reads contain only policy-facing messages, output, Reward composition and execution hashes. Private world snapshots remain with the execution owner. The client checks workspace/request identities and the returned result hash.

`verifyModelStarterEnvironmentAttempt` validates the bounded runtime artifact hash, task input, seed and JavaScript release. The host must separately establish who recorded those bytes and bind them to its admitted attempt before using private state for grading. The shared schema also replaces Desktop's private copy of the environment-attempt envelope.

`choices` reads a paginated list of task IDs, input previews and authored fixture IDs for one exact attached Taskset, plus available hosted model choices. It does not return private state or expected outputs. Unsupported execution contracts remain explicit in this read response. Execution admission revalidates every selection; a choices response does not itself authorize a model call.
# Publisher privacy review

`ModelStarterPrivacyReviewSchema` describes a catalog publisher's review of an
original synthetic package. Put it in `taskset.metadata.starterAuthoring.privacyReview`.
`modelStarterPrivacyContentHash` binds the review to the complete package, excluding
the review and the outer hashes containing it. Set the review, then reseal the
Taskset and starter. Validation rejects stale reviews after content changes.
Desktop uses this authenticated catalog attestation to resolve synthetic contact
data findings, retains it in source provenance, and still blocks secret findings.
This is not an approval field accepted in a model creation request or arbitrary import.

### Execution services

SDK 0.1.14 requires Evals 0.7.6 or later. A starter's immutable JavaScript environment
may declare `executionServices` for bounded SQLite queries or separately isolated
candidate JavaScript. Creation preserves those declarations in the private execution
asset and verifies their environment hash. Changing a binding requires a new sealed
execution release; dropping or rewriting it cannot preserve the admitted identity.
Existing environments without services retain their original content hashes.

Keep hidden case inputs and expected results in the private initial-state asset.
Ordinary task input is policy-visible. The service passes only each hidden case's
explicit `input` to candidate code; expected results stay with the authored grader.
See the Evals JavaScript environment contract for service fields and Node execution.

### Complete Taskset evaluation runs

`OpenPondModelTasksetRunsClient` from `openpond-sdk/model-taskset-runs` exposes
`create`, `get`, `list`, `cancel` and `result` through
`/v1/model-taskset-runs`. A request pins a Model attachment and an ordered
population of `{ receiptId, taskId, seed, fixtureId }` members. Receipt IDs are
unique within the run; hosted seeds are canonical integer strings between
`0` and `2147483647`. Requests support up to 10,000 members and never accept
replacement world state, verifier bytes or caller-generated scores.

Use `{ kind: "fixture" }` with each member's authored fixture ID to check a
package without claiming model execution. Use a `hosted_chat` policy with a
model ID and sampling/output limits for a model evaluation; those members
have `fixtureId: null`. A model evaluation pins both the provider snapshot and
the requested sampling configuration. Reusing an operation ID must return the
same admitted request or report a conflict.

Details retain the request, immutable public run manifest, policy snapshot and
current summary. Terminal results retain canonical receipts in admitted order
and the authored metric only for completed evaluations. Failed and cancelled
runs cannot publish a metric value; completed but entirely unscorable runs
retain a null metric value. The client verifies workspace, manifest,
population, grading role, metric references and result hashes on readback.
Hosts remain responsible for owner-authenticated evidence and durable
dispatch/cancellation; a content hash is not producer authentication.
