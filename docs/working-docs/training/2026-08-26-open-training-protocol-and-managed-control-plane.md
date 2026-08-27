# 2026-08-26 Model Project Protocol and Managed Training Control Plane

Status: Implementation and final acceptance in progress. The released package
is pinned, OpenPond's client/Draft migration and Sandbox's V2 artifact/Job
cutover are live, and the bounded V2 Reward Model and one-step policy canaries
passed. Specialized public creation has moved to V2. The full sixteen-step
proof remains pending a capacity-corrected staging deployment and retry.

Latest checkpoint: 2026-08-27. `@openpond/harness@0.2.5` and
`openpond-sdk@0.0.16` are published and pinned. Sandbox migration
`0102_last_vertigo` is live, new managed creation goes through the public V2
Training Job protocol, and the bounded Reward Model and one-step learned-reward
policy canaries both passed with immutable outputs, separate execution and
qualification evidence, bounded spend, and zero-resource cleanup. OpenPond PR
#192 includes Project-owned training setup, V2 clients and projections, removal
of the retired private evidence mapper, and separate Run/Version receipt and
qualification UI. Its current gates pass typecheck, source structure,
production reachability, and 439 files / 2,193 unit tests with one skip.
Sandbox's capacity-corrected managed-RL service passes 202 affected tests and
the Python 3.12 worker passes 40 tests. The first sustained A40 proof retained a
valid three-step partial checkpoint and cleaned up; two advertised H100 shapes
then failed before pod creation at zero spend. Sandbox `develop` now prefers
the remaining affordable H100 HBM3 shape for bounded long training, and its CI
workflow pins the real Python/runtime dependency. The next staging rollout is
waiting only on interactive renewal of the operator's expired Google
credential. The user explicitly confirmed that all documented paid canaries,
the final Duck Run, and necessary non-overlapping retries need no additional
spend approval.

Related docs:

- [OpenPond Managed Training Service](./2026-07-11-openpond-managed-training-backend.md)
- [Versioned Harness Releases and Portable Training](./2026-07-23-versioned-harness-releases-and-portable-training.md)
- [Harness Evaluation and Managed RL Review Loop](./2026-08-08-harness-evaluation-managed-rl-review-loop.md)
- [Sandbox Managed RL Platform](../../../../sandbox/docs/working-docs/sandbox/2026-07-16-openpond-managed-rl-platform.md)
- [Autonomous Learned-Preference Rollout Smoke](../../../../sandbox/docs/working-docs/training/2026-08-25-autonomous-learned-preference-rollout-smoke.md)
- [Learned Preference Model and GRPO Loop](../../../../sandbox/docs/working-docs/training/2026-08-25-learned-preference-model-grpo-loop.md)
- [Portable Training Telemetry and Run Explorer](../../../../sandbox/docs/working-docs/training/2026-08-25-portable-training-telemetry-and-run-explorer.md)
- [Sixteen-Step Managed RL Learning Run](../../../../sandbox/docs/working-docs/training/2026-08-26-sixteen-step-managed-rl-learning-run.md)
- [Prime Intellect Verifiers](https://github.com/PrimeIntellect-ai/verifiers)
- [PRIME-RL](https://github.com/PrimeIntellect-ai/prime-rl)
- [Prime Lab architecture](https://docs.primeintellect.ai/hosted-training/what-is-lab)

## Summary

OpenPond is both the product and the open-source definition of the post-training
workflow. It should publicly define what a training job means, how it refers to
Harnesses, Tasksets, Datasets, Evidence Sets, Models, recipes, rewards, budgets,
events, outputs, and receipts, and how the same job can be executed locally or
by a hosted provider.

Sandbox is OpenPond's managed training service. It should implement the public
OpenPond protocol while privately owning authentication, tenancy, provider
selection, GPU and rollout-sandbox leases, worker coordination, metering,
artifact custody, recovery, and cleanup. OpenPond and Sandbox should therefore
remain aligned on domain concepts, but they should not maintain competing
definitions or share private operational state.

The target is not a feature-reduced generic GPU endpoint. The target is a small,
stable OpenPond training API backed by the substantial managed-RL machinery
that already exists:

```text
OpenPond open-source product and protocol
  -> author one mutable Model Project and its current training setup
  -> author and version Harness, Taskset, Dataset, Evidence, Model, and Recipe
  -> snapshot the Project setup into an immutable Training Job submission
  -> evaluate, qualify, compare, select, promote, reject, or roll back results

Sandbox managed control plane
  -> authenticate the team and admit the requested capabilities and budget
  -> resolve private provider, placement, worker, storage, and lease details
  -> orchestrate rollout environments, inference, optimization, and cleanup
  -> return portable status, events, output artifacts, and an execution receipt

Training data plane
  -> isolated CPU rollout sandboxes
  -> trusted GPU inference and trainer workers
  -> content-addressed artifact storage
```

The simplified product lifecycle is:

```text
Model Project
  mutable identity, objective, defaults, resource links, and one current setup
        ↓ save/sync the exact Project revision
Training Job
  immutable Taskset, Harness, Model, method, recipe, destination, and approval
        ↓ execute and observe through the hosted API
Job events, outputs, receipt, Model Versions, and evaluations
  immutable history associated back to the source Project
```

There is no public `ModelRunDraft` between Project and Job. Unsubmitted setup
is Project authoring state. Submitted execution is immutable Job history.

The migration must preserve the working managed flow. It must not replace the
orchestrator, restart active jobs under a new schema, launch duplicate paid
jobs during comparison, or require a PRIME-RL adapter that does not currently
exist.

## Current Code Review

### OpenPond already defines most of the public vocabulary

- `packages/contracts/src/training-platform.ts` defines public engine, compute,
  and Harness-runtime capabilities, `ResolvedTrainingPlan`, adapter validation,
  execution references, execution status, and portable artifacts.
- `packages/contracts/src/training-policy-optimization.ts` defines policy
  optimization, GRPO/PPO, budgets, dataset selection, environment identity, and
  learned-preference reward bindings.
- `packages/contracts/src/training.ts` and
  `packages/contracts/src/model-lifecycle.ts` define the broader training,
  Model Run, Model Version, and Reward Model lifecycle.
- `packages/training-sdk/src/adapters.ts` defines the provider-neutral engine
  adapter lifecycle: capabilities, validation, launch, signals, status, logs,
  cancellation, and artifact collection.
- `apps/server/src/training/portable-model-run-service.ts` and
  `portable-model-run-lifecycle.ts` already drive a Model Run through those
  portable execution states.
- `apps/server/src/training/openpond-managed-training-adapter.ts` already
  serializes an immutable portable submission, launches it through Sandbox,
  polls status and logs, cancels with optimistic version protection, and
  collects the terminal candidate artifact.
- `apps/server/src/training/reward-model-launch-input.ts` separately creates the
  current managed Reward Model request from an immutable preference dataset.
- `apps/server/src/training/reward-model-qualification-projection.ts` creates
  the OpenPond Reward Model Version, run receipt, and content-addressed
  qualification report after receiving Sandbox evidence. This confirms that
  product qualification already belongs on the OpenPond side of the boundary.

The public source already contains the desired concepts, but the consumable
package boundary is incomplete. `@openpond/contracts` and
`@openpond/training-sdk` are currently workspace-private packages. The existing
MIT-licensed `openpond-sdk` package is already public, independently versioned,
and published with provenance, but it does not yet export Model Project or
training subpaths. Sandbox therefore duplicates parts of the contracts instead
of consuming those narrow public SDK entry points.

### Model Project synchronization already exists, but is incomplete

- `apps/server/src/training/model-project-hosting.ts` pushes a portable Project
  to `PUT /v1/model-projects/{portableProjectId}` with optimistic ETag state and
  persists the resulting hosted identity, revision, and Taskset links locally.
- The current managed adapter includes the hosted Project ID and portable
  Project ID in a submitted managed job, so hosted Jobs can already be grouped
  under the correct Project.
- Sandbox already supports team-scoped Project upsert, list, detail, Taskset
  release association, and a detail projection over Jobs, Versions, and serving
  resources.
- OpenPond does not yet pull the complete hosted Project/job collection back
  into Desktop. It primarily knows the managed Jobs that its local store
  submitted. An SDK or API-originated Job therefore is not guaranteed to appear
  in Desktop without an explicit hosted refresh path.
- Current synchronization covers Project metadata/defaults and published
  Taskset associations. It is not a general bidirectional merge of authoring
  drafts, evidence, evaluation state, or UI state.

The target is not peer-to-peer synchronization between two local databases.
Portable clients author and revision the Project; the hosted API stores its
team-scoped projection and is authoritative for managed Job state. Desktop and
Sandbox read the same hosted Job collection by Project ID.

### Current OpenPond authoring is uneven

The actual Project editor is much thinner than the surrounding Taskset and
training UI:

- Project creation exposes name, description/objective, an optional starting
  Model, and a train-versus-benchmark flow choice. The flow choice and benchmark
  Model are not general persisted Project configuration.
- After creation there is no complete Project settings editor. Existing
  Project name/objective/defaults are mostly displayed, and the main Project
  action is hosted synchronization. `defaultDestinationId` exists in the
  schema without a clear direct editor.
- `ModelRunDraftSchema` separately stores Taskset ref, method, base Model,
  destination, rollout placement, preset, recipe, and workflow status. The Run
  editor saves both the Project and this separate Draft before preparation and
  launch.
- The UI can technically retain multiple unfinished Run Drafts per Project.
  The accepted simplification removes that capability in favor of one current
  Project training setup plus immutable submitted Job history.
- Scenarios and general evaluation inputs are not hardcoded. The Taskset draft
  editor supports train/validation/test/frozen-eval splits, scenario inputs and
  references, environments, output contracts, graders, fixtures, human-review
  rubrics, and reward aggregation. The fixed Harness Refiner benchmark is a
  special shipped evaluation, not the general Project evaluation model.

This cleanup should improve the Project settings experience eventually, but it
must not mistake the rich Taskset editor for Project fields or move Taskset
contents into the Project row.

### Sandbox already has the managed-job control plane

- `deployment-worker/api/handlers/managed-rl-handler.ts` already exposes job
  creation, listing, detail, cancellation, stop-after-group, logs, events, and
  artifacts.
- `deployment-worker/domain/services/managed-rl/service.ts` has one central
  `create()` admission path. Portable launches, Reward Model launches, and
  calibration batches construct an input bundle and eventually call that same
  job creation operation.
- `lib/db/schema/managed-rl.ts` and
  `deployment-worker/domain/services/managed-rl/store.ts` provide durable,
  team-scoped jobs and resource state.
- `training-orchestrator.ts`, `worker-control.ts`, `rollout-pool.ts`,
  `policy-gateway.ts`, `artifact-store.ts`, and `terminal-cleanup.ts` implement
  the operational work expected from a managed training control plane.
- The worker protocol already separates private worker registration, polling,
  policy inference, training commands, artifact upload, telemetry, and cleanup
  from the signed-in product routes.

The current endpoint surface is larger than the underlying resource model:

```text
/v1/managed-rl/jobs
/v1/managed-rl/launches
/v1/managed-rl/portable-launches
/v1/managed-rl/reward-model-launches
/v1/managed-rl/calibration-batches
/v1/managed-rl/approvals
/v1/managed-rl/releases
/v1/managed-rl/materializations
/v1/managed-rl/assets
/v1/managed-rl/reward-model-artifacts
```

This is API evolution debt, not evidence that the managed system is missing.
Several routes are specialized request builders over the same durable job
core.

### The public/private seam currently drifts

- `lib/sandbox/managed-rl/portable-submission.ts` repeats OpenPond-shaped
  `RewardModelVersion`, qualification report, checkpoint, processor, composer,
  and qualification-kind contracts.
- `lib/sandbox/managed-rl/reward-model-launch.ts` creates OpenPond-shaped
  Harness, manifest, evidence, and run identities inside Sandbox rather than
  accepting one canonical public submission.
- OpenPond's managed adapter hardcodes the currently accepted Model profile,
  recipe, worker protocol, and upstream revision rather than retrieving one
  authoritative capability document from Sandbox.
- Sandbox has `provider-inventory` and quote endpoints but no small public
  OpenPond training-capabilities endpoint.
- The current learned-reward binding is validated structurally in Sandbox, but
  it does not yet bind a Sandbox-issued execution/artifact receipt that proves
  the submitted checkpoint is the artifact produced for that team and job.
- Product qualification terminology such as `synthetic_smoke`,
  `human_heldout`, and `productionRewardEligible` has leaked into hosted
  admission even though reward provenance and intended use are OpenPond product
  concerns.

### Current training proof that must remain working

The 2026-08-25 documented managed proof completed the following concrete
resource and execution lifecycle:

```text
preference collection
  -> immutable grouped preference dataset
  -> real Reward Model training Job and checkpoint
  -> checkpoint reload and structured scorer evidence
  -> learned-reward policy rollout groups
  -> one real policy optimizer update
  -> updated Policy checkpoint publication and reload
  -> bounded evaluation
  -> terminal provider cleanup
```

The recorded managed job is `yiwa4qg7omxtxy0owes0os7s`. It used synthetic
fixture preference labels, but the training, learned-reward inference, policy
weight update, artifact, evaluation, spend, and cleanup operations were real.
That proof establishes pipeline behavior, not human-preference generalization.

The migration regression baseline must preserve at least:

- immutable OpenPond source Run and manifest lineage;
- team-scoped authentication and object ownership;
- quote freshness, budget, idempotency, and no duplicate provisioning;
- local and remote Harness placements;
- rollout claiming, completion, retry, and exact policy-version lineage;
- Reward Model train/validation input and structured scorer output;
- frozen learned-reward use during policy optimization;
- checkpoint inventories and required Reward Model files;
- logs, events, metrics, trajectory evidence, and terminal artifacts;
- cancellation and stop-after-group semantics;
- provider, sandbox, reservation, capability, and storage cleanup evidence;
- OpenPond Model Run, Reward Model Run, Model Version, and report projection.

V2 initially changes only the OpenPond-to-Sandbox managed transport. Existing
local, custom-compute, and provider-native engine adapters continue through the
current `@openpond/training-sdk` lifecycle. Their Model Run persistence,
status, cancellation, artifact collection, evaluation, and UI behavior must
remain covered by the general portable Model Run tests even though they do not
call the new hosted endpoint.

### PRIME-RL is an example, not a current OpenPond adapter

There is no executable PRIME-RL adapter in the current OpenPond source tree.
Historical working docs describe a possible `python/openpond-training`
PRIME-RL adapter, but that source package is not present in the current tree.
It must not be treated as an implemented migration dependency.

The current Sandbox worker also performs the active bounded training through
its own `managed-rl-worker/policy_trainer.py` and
`reward_model_trainer.py`. The policy trainer is a small direct
PyTorch/Transformers/PEFT single-GPU GRPO updater; it does not import and invoke
the upstream PRIME-RL trainer. Sandbox retains PRIME-RL-shaped provenance and
planning seams, but the working proof is not evidence of a current upstream
PRIME-RL adapter.

PRIME-RL remains a useful architectural example and a possible later engine
plugin. It is not part of this API cleanup's definition of done.

## External Architecture Reference

Prime Intellect demonstrates the intended division without defining OpenPond's
contract for us:

- The open-source Verifiers library defines Tasksets, task data, Harnesses,
  tools, traces, rewards, judges, and evaluation behavior.
- The open-source PRIME-RL engine separates inference, an environment/rollout
  orchestrator, and the trainer.
- Prime Hosted Training accepts public model, environment, sampling, step, and
  checkpoint configuration, while the hosted service owns placement,
  multi-tenancy, billing, storage, and operations.
- The same Verifiers environment can run locally, in hosted evaluation, or in
  hosted training without changing its product meaning.

The OpenPond analogue is:

| Prime ecosystem | OpenPond architecture |
| --- | --- |
| Verifiers Taskset, Harness, Trace, reward | OpenPond Taskset, Harness, Attempt, Evaluation, and reward/evidence contracts |
| PRIME-RL public engine/configuration | OpenPond public training protocol plus replaceable engine adapters |
| Prime CLI and Lab workspace | OpenPond desktop, server, CLI, Lab, and Models experience |
| Prime Hosted Training | Sandbox managed training control plane |
| Prime private placement and multi-tenancy | Sandbox provider, lease, worker, metering, and cleanup implementation |

The lesson is to keep domain concepts public and portable while keeping
operational resolution private. It is not to rename OpenPond resources after
Verifiers or to require PRIME-RL as the only engine.

## Product Decisions

### 1. Model Project is the open-source product boundary in the existing SDK

The canonical shared schemas live in the OpenPond repository under the MIT
license. OpenPond owns their naming, versioning, fixtures, documentation, and
compatibility policy.

Use the existing public `openpond-sdk` package instead of creating
`@openpond/model-project` or a separate generic Training Protocol package. Add
pure subpath exports whose dependency graph does not pull in the application
server, cloud clients, databases, credentials, or Node-only runtime behavior.
OpenPond can re-export the same definitions from `@openpond/contracts` during
migration so internal callers move without maintaining duplicate schemas.

The public SDK surface owns the coherent domain:

```text
openpond-sdk/model-projects
  ModelProject, current training setup, immutable resource refs,
  hosted sync/list/detail contracts, Project revision and lineage

openpond-sdk/training
  capabilities, quote and artifact inputs, immutable Job submission,
  Job status/control, events, logs, outputs, and execution receipts
```

The public subpaths must be usable by:

- OpenPond desktop/server and CLI;
- Sandbox;
- a local or user-connected worker;
- a third-party managed training provider;
- conformance tests without importing the OpenPond application server.

They should have a small dependency closure and no database, Electron,
provider, cloud, credential, or UI dependency. Split another npm package only
if a measured independent-versioning or dependency problem appears later.
Adding a second mutable `Training Project`, public Draft type, or second package
for the same lifecycle would duplicate the product boundary and make ownership
less clear.

### 2. A Model Project owns one mutable current training setup

The original Model Project intuition is correct. A Model Project is where the
user defines and revisits the training setup over time. It is the long-lived,
mutable aggregate for:

- the objective and target behavior;
- preferred base Model and managed/local destination defaults;
- relevant Tasksets, Datasets, Evidence Sets, and Harness Releases;
- one current unsubmitted training setup and preferred budget/retention inputs;
- completed, failed, and cancelled Model Runs;
- Policy and Reward Model Versions;
- evaluations, qualification reports, comparisons, and diagnostics;
- the explicitly selected/default Version and rollback history.

The Training Protocol is the immutable execution boundary produced from the
current approved setup inside that Project. It does not replace the Project:

```text
Model Project
  mutable objective, defaults, resource refs, and one current training setup
        ↓ save/sync exact revision, approve, and snapshot
OpenPond Training Job Submission
  immutable, content-addressed request with source Project ID and revision
        ↓
Sandbox managed Job
  placement, workers, training, artifacts, metering, cleanup
        ↓
Execution outputs and receipt
        ↓
OpenPond Run view + Model Version + evaluation/qualification
  attached back to the Model Project
```

The current code already points in this direction. `ModelProjectSchema` owns
name, objective, default base Model, default destination, hosted identity, and
Taskset synchronization, while `ModelRunDraftSchema` owns the exact Taskset,
Harness, Model, method, recipe, placement, and run preset. Move the useful
unsubmitted configuration into a bounded `trainingSetup` field on the Project,
then remove the separate Draft schema, storage, status, actions, and UI rows.
Do not turn the mutable Project row itself into the submitted manifest: Job
creation snapshots the exact Project revision and resolved immutable refs into
a new Training Job.

One Project has one resumable current setup. A new submission may update that
setup and create another immutable Job. Multiple simultaneous unfinished Drafts
are intentionally not part of the product model. If that need later becomes
real, introduce an explicitly named saved configuration resource rather than
reviving ambiguous Run Draft terminology.

The migration is a field-ownership cleanup, not a mechanical type rename:

| Current `ModelRunDraft` field | Target owner |
| --- | --- |
| `tasksetRef`, `tasksetRelease`, `harnessRelease` | `ModelProject.trainingSetup` as exact immutable refs |
| `baseModel`, `method`, `destinationId`, `managedRolloutPlacement`, `runPreset`, `recipe` | `ModelProject.trainingSetup` |
| preferred spend ceiling and retention | Mutable Project setup; copied into the submitted Job approval |
| explicit export approval, `approvedAt`, approval hash | Immutable submitted Job only; never silently reused from an older Job |
| `datasetMode`, `datasetCreationId` | Transient editor/navigation state |
| `buildIntent`, `buildSpecification` | Taskset/Dataset authoring state, referenced by Project rather than duplicated |
| Draft `id`, `title`, `status`, `createdAt`, `updatedAt` | Removed; Project revision/timestamps and immutable Job identity replace them |

Published Taskset/Harness refs remain exact on the setup so submission is
reproducible. Large Taskset contents, evidence, Job history, and Version history
remain separate resources linked by ID and hash rather than embedded in the
Project row.

### Architectural guardrails

The simplification is valid only while these invariants hold:

1. **Model Project stays bounded.** It owns identity, objective, defaults,
   resource references, and one current training setup. It does not embed
   Taskset contents, raw evidence, Job events, logs, artifact inventories,
   evaluation history, or Version history.
2. **Run is the product projection of Job.** A submitted Training Job is the
   durable Run identity. Do not create another mutable Model Run record between
   Project and Job. UI Run pages join the Job with its events, outputs, receipt,
   and resulting Versions.
3. **Portable clients are the authoring authority.** “Desktop is canonical”
   means OpenPond Desktop, CLI, and other authorized SDK clients author portable
   Project revisions. It does not mean a running Desktop process must remain
   online or that only the Desktop UI may use the protocol.
4. **The hosted API is authoritative for managed execution.** Managed Job
   status, controls, spend, events, logs, outputs, and receipts are read from the
   hosted API. Do not synchronize independent local and hosted Job state with
   last-write-wins merging.
5. **Approval is per immutable Job.** A Project may remember preferred spend
   and retention settings. Export authorization, approval timestamp, approval
   hash, and the exact approved ceiling are captured anew on every submission.
6. **Immutable resources keep distinct identities.** Taskset, Harness, Dataset,
   Evidence, Model Version, Reward Model Version, and evaluation receipts remain
   separate versioned resources connected by exact refs and hashes.
7. **One current setup is intentional.** Do not restore multiple unfinished
   Drafts preemptively. Add a clearly named saved-configuration or branching
   resource only after a demonstrated workflow requires parallel unsubmitted
   setups, collaboration on alternatives, or reusable parameter templates.
8. **Contract cleanup precedes UI redesign.** Preserve the working training
   experience while changing storage and transport. Sandbox UI decisions remain
   deferred until the Project/Job contract and cross-client visibility are
   proven.

Warning signs that the design is drifting are an unbounded Project response, a
second mutable Run-like entity, approvals copied from an earlier Job, Desktop
and hosted Job status disagreeing, or provider/worker state appearing in the
public Project schema.

Sandbox may retain the immutable source Model Project ref on each job for team
scoping, filtering, and lineage. It does not need to own Project defaults,
selected Versions, promotion, rollback, or the complete Project aggregate.
Hosted Model Project synchronization remains a separate OpenPond product API;
it should not be folded into `/v1/training/jobs`. Submitting a Job first syncs
the latest Project revision, then sends the immutable Job. The API associates
the Job with that Project without rewriting the Project from runtime progress.

### Sandbox UI changes are deferred; shared API visibility is not

This migration does not redesign or remove Sandbox UI controls. In particular,
it does not yet remove hosted Project creation, build a hosted authoring
experience, or decide the final placement of version/serving controls. That is
a separate product pass after the Project and Job contracts are stable.

The API boundary is decided now because it is required for correct shared
visibility:

```text
Model Project product API
  Project upsert/list/detail, revisioned resource links, and synchronization

Managed training execution API
  capabilities, quotes, artifacts, jobs, controls, events, logs and outputs
```

OpenPond Desktop and SDK clients author the portable Project. Both Desktop and
Sandbox can later render hosted Project and Job projections from these APIs.
The current implementation phase changes contracts and data flow only; it does
not require Sandbox UI work.

### Make decisions immutable, not every piece of UI state

“Immortalize” the evidence and decisions needed to reproduce and audit a
result. Keep authoring state mutable and keep rebuildable indexes derived:

| Lifecycle class | Examples | Rule |
| --- | --- | --- |
| Mutable authoring | Project objective/defaults/current training setup, Dataset drafts, Harness drafts, review queues, notes | Revisioned and editable until publication or approval |
| Immutable releases/evidence | Published Taskset, Dataset, Evidence Set, Harness and grader releases; human receipts; approved job submission; execution/evaluation/qualification receipts; Model Versions | Content-addressed and never silently rewritten |
| Derived projections | Dashboards, search indexes, summaries, cached capabilities, recommendation views | Rebuildable from authoritative records |
| Private operational state | Provider leases, worker tokens, placement, queues, temporary materializations | Sandbox-owned, retained only as operational policy requires |

Hidden evaluation contents and raw human evidence remain permissioned. A UI
can show identity, counts, hashes, coverage, and results without exposing held-
out answers to a trainer, rollout worker, or unauthorized collaborator.

### 3. OpenPond domain concepts stay in the managed API

Alignment does not mean that the API becomes an untyped generic GPU request.
The public job should retain immutable references to the OpenPond resources
that explain the run:

- Model Project ID, source revision, and submission hash;
- Harness Release and Harness Run Manifest;
- Taskset and Dataset Releases;
- Evidence Set and preference dataset references;
- selected Model Version and reward-source references;
- recipe and evaluation-policy references;
- user-approved budget and retention intent.

Sandbox validates content hashes, ownership, compatibility, and executable
capabilities. It must preserve these references in events and receipts. It does
not create competing canonical OpenPond versions or reinterpret their product
meaning.

### 4. One public job resource replaces specialized launch resources

The public protocol has one job union with explicit kinds. The initial V2
implementation needs only the kinds already proven by the current managed
system:

```ts
type OpenPondTrainingJobKind =
  | "reward_model_train"
  | "policy_optimize";
```

Later additions such as `sft`, `preference_optimize`, or another optimizer must
be added as versioned union members with capability negotiation and conformance
tests. Do not imply support from a method name alone.

Preference calibration is not necessarily a training job. Keep its existing
endpoint during migration, then decide whether it becomes an OpenPond
evaluation job or a reusable inference operation. Do not force it into the
training union merely to reduce the route count.

### 5. Sandbox owns execution, not product qualification

Sandbox owns:

- request authentication and team authorization;
- capability and resource admission;
- quote validation and budget reservation;
- provider and data-plane selection;
- worker, rollout-sandbox, and scorer leases;
- training and inference process lifecycle;
- job state, events, logs, metrics, and retries;
- artifact upload, byte inventory, hashes, and retention;
- metering, cancellation, recovery, and terminal cleanup;
- a signed or authenticated execution receipt.

OpenPond owns:

- Dataset, Evidence, Taskset, Harness, and Model identities;
- split and held-out evaluation authority;
- reward provenance and intended-use claims;
- evaluation and qualification policy;
- Reward Model and Policy Model Versions;
- comparison, selection, promotion, rejection, binding, and rollback.

Sandbox may execute an evaluation requested by OpenPond and report the measured
result. OpenPond remains the authority that interprets the result for a named
product use.

### 6. Synthetic versus human is not a universal admission gate

The public protocol may preserve evidence provenance and qualification-report
references for lineage, but Sandbox must not reject a reward source merely
because it is synthetic.

Sandbox admission rejects unsupported or unsafe execution: invalid hashes,
unauthorized artifacts, missing files, unsupported models or methods,
incompatible runtimes, stale quotes, exceeded budgets, or unexecutable scorer
artifacts.

OpenPond decides whether the supplied evidence supports a requested claim. A
synthetic fixture can qualify pipeline behavior; a deterministic environment
reward can be a valid production objective; a claim about human preference
requires appropriate held-out human evidence.

Replace binary hosted authority such as `productionRewardEligible` with
OpenPond-owned provenance and `qualifiedFor` claims when that product model is
revised. This semantic cleanup must not block the transport migration.

### 7. Trainer engines remain replaceable

The V2 protocol describes requested methods and required capabilities, not one
trainer's internal configuration graph. Sandbox resolves those requirements to
the currently supported worker implementation.

The current direct managed trainer remains supported throughout migration. A
future PRIME-RL, TRL, veRL, or other adapter must implement the same OpenPond
job, event, output, cancellation, and receipt conformance suite. Adding
PRIME-RL is a separate measured engine project, not part of the API cleanup.

## Public Protocol Shape

### Training job submission

The exact schema belongs in `openpond-sdk/training`. This
illustrative shape records product meaning while leaving private placement
unresolved:

```ts
interface OpenPondTrainingJobSubmissionV2 {
  schemaVersion: "openpond.trainingJobSubmission.v2";
  kind: "reward_model_train" | "policy_optimize";
  idempotencyKey: string;
  name: string;
  source: {
    modelProject: {
      id: string;
      revision: number;
      contentHash: string;
    };
    harnessRunManifest: HarnessRunManifest;
    taskset: ImmutableRef;
    dataset: ImmutableRef;
    evidenceSets: ImmutableRef[];
  };
  job:
    | RewardModelTrainingRequestV2
    | PolicyOptimizationRequestV2;
  requestedCapabilities: TrainingCapabilityRequirement[];
  budget: {
    maximumSpendUsd: number;
    maximumWallSeconds: number;
  };
  retention: {
    outputArtifacts: "job" | "team_retained";
  };
  approval: {
    approvalHash: string;
    approvedAt: string;
  };
  contentHash: string;
}
```

The Job ID is the Run identity. There is no separate source Draft or mutable
Model Run record in the public request. Any user-facing “Run” is a projection
of the immutable Training Job plus its events, outputs, receipt, and resulting
Versions.

The job-specific payload can carry OpenPond concepts directly. For example, a
policy job using learned reward may include:

```ts
interface LearnedRewardSourceV2 {
  kind: "learned_reward";
  rewardModelVersion: ImmutableRef;
  qualificationReport: ImmutableRef | null;
  scorerArtifact: {
    artifactRef: string;
    contentHash: string;
    executionReceipt: ImmutableRef;
  };
  processorRelease: ImmutableRef;
  rewardComposerRelease: ImmutableRef;
}
```

`qualificationReport` is portable lineage selected by OpenPond. Sandbox uses
the scorer artifact and authoritative execution receipt for artifact admission;
it does not infer production eligibility from the report kind.

### Capabilities

`GET /v1/training/capabilities` returns an
`openpond.trainingCapabilities.v2` document defined publicly by OpenPond. It
should include stable capability/profile IDs and bounded ranges for:

- accepted job kinds and methods;
- Model and processor profiles;
- reward-source kinds;
- runtime placements;
- worker protocol versions;
- output artifact and scorer capabilities;
- cancellation, local rollout, resume, and retention support;
- budget and task/rollout bounds;
- a capability receipt and expiry/check time.

It should not expose provider credentials, internal pool IDs, placement
heuristics, private capacity reservations, or secret-bearing worker
configuration.

OpenPond uses the document for UI choices and preflight. Sandbox performs final
admission again at job creation. The immutable recipe records what was asked to
run; capabilities record what Sandbox can currently run.

### Status, events, outputs, and receipt

The protocol should define:

- `OpenPondTrainingJobV2` for durable identity, state, phase, version, progress,
  timestamps, budget usage, and terminal reason;
- `OpenPondTrainingEventV2` for ordered, cursor-addressable lifecycle events;
- `OpenPondTrainingLogEntryV2` for redacted human-readable logs;
- `OpenPondTrainingOutputV2` for checkpoint, adapter, scorer, metrics,
  evaluation, trace, and receipt artifacts;
- `OpenPondTrainingExecutionReceiptV2` for the authoritative execution and
  artifact statement.

The execution receipt should bind:

```text
team and job identity
submission content hash
resolved public manifest hash
recipe and capability hashes
worker/runtime release identity
input artifact refs and byte hashes
terminal checkpoint and complete file inventory
metrics/evaluation artifact refs
spend and duration summary
cleanup result
issuer, issue time, and signature or authenticated receipt reference
```

The public schema defines these fields. Sandbox is the issuer for a managed
run. A local worker may issue an unsigned/local receipt with an explicitly
different authority level while preserving the same factual shape.

## API Surface

### Model Project synchronization API

Keep Project authoring and synchronization separate from execution:

```text
PUT  /v1/model-projects/{portableProjectId}
GET  /v1/model-projects
GET  /v1/model-projects/{projectId}
```

Upsert saves an exact portable Project revision with optimistic concurrency.
List/detail return the team-scoped hosted projection and bounded resource
summaries. Detail must include, or link to, the Jobs associated with the
Project so Desktop can refresh API/SDK-originated Runs instead of only showing
Jobs already present in its local store. A filtered
`GET /v1/training/jobs?modelProjectId=...` is acceptable as the Job collection;
the Project response does not need to embed unbounded Job history.

Submitting a managed Job follows one ordered path:

```text
save local Model Project
  -> PUT latest Project revision
  -> resolve and hash immutable releases
  -> POST immutable Training Job referencing Project ID and revision
  -> refresh hosted Project/Job projection
```

Do not send the entire mutable Project as the training payload, allow training
progress to mutate the Project revision, or implement conflicting peer-to-peer
merges between Desktop and Sandbox.

### Public OpenPond managed-training API

The desired signed-in product surface is:

```text
GET  /v1/training/capabilities
POST /v1/training/quotes
POST /v1/training/artifacts

POST /v1/training/jobs
GET  /v1/training/jobs
GET  /v1/training/jobs/{jobId}
POST /v1/training/jobs/{jobId}/cancel
POST /v1/training/jobs/{jobId}/stop-after-group

GET  /v1/training/jobs/{jobId}/events
GET  /v1/training/jobs/{jobId}/logs
GET  /v1/training/jobs/{jobId}/outputs
```

This is the intended stable surface and is sufficient for the currently proven
managed workflows:

- `capabilities` answers what Sandbox can execute now;
- `quotes` separates price/capacity review from paid creation;
- `artifacts` stages immutable inputs and large bundles;
- `jobs` creates and lists durable execution resources;
- job detail carries status, phase, version, progress, spend, and terminal
  failure information;
- `cancel` and `stop-after-group` cover the supported control semantics;
- `events`, `logs`, and `outputs` cover observation and result collection.

Do not add public endpoints for internal provider leases, rollout pools,
workers, scorer registration, materialization stages, checkpoint publication,
or cleanup sub-resources. Those are internal phases or outputs of a job. A
later public resource should be added only when it has an independent user
lifecycle that cannot be represented as a job input, state transition, event,
or output.

Resume from a checkpoint should initially create a new job whose submission
pins `resumeFrom`, preserving an immutable run boundary. Do not add arbitrary
pause/resume controls until the trainer and resource lifecycle genuinely
support them. A persistent scorer endpoint is likewise unnecessary while a
scorer can remain a verified artifact that Sandbox leases internally for the
duration of a consuming training job.

The final URL versioning convention can remain `/v1` while schema versions
advance, or move to `/v2/training`; it must be chosen once and documented. The
schema version, not route spelling alone, is the compatibility authority.

Artifact upload should move to presigned or bounded content-addressed upload
for large bundles. The initial adapter may preserve the current bounded inline
upload where necessary, but a generic endpoint must not retain media-type rules
specific to Reward Model screenshots or one fixture.

### Private Sandbox control and worker API

These remain Sandbox implementation details and need not be standardized in
the OpenPond product protocol:

```text
/v1/managed-rl/workers/*
/v1/managed-rl/policy/*
provider inventory and lease reconciliation
worker bootstrap assets and one-use tokens
internal materialization records
artifact upload grants
resource reservations and cleanup commands
operator-only diagnostic and repair operations
```

The public handler may delegate to the existing managed-RL service and store.
Renaming internal tables, phases, worker endpoints, and storage prefixes is not
required for V2.

## Current-to-Target Route Mapping

| Current route | V2 disposition |
| --- | --- |
| `POST /managed-rl/portable-launches` | `POST /training/jobs` with `kind: policy_optimize` |
| `POST /managed-rl/reward-model-launches` | `POST /training/jobs` with `kind: reward_model_train` |
| `POST /managed-rl/jobs` | Internal create core behind the public V2 adapter |
| `GET /managed-rl/jobs*` | V2 list/detail/status/events/logs/outputs projections |
| `POST /managed-rl/reward-model-artifacts` | Generic content-addressed training artifact upload |
| `POST /managed-rl/assets` | Generic artifact upload or private materialization input |
| `POST /managed-rl/releases` | Fold into immutable refs/artifacts; keep internal if needed |
| `POST /managed-rl/materializations` | Private resolution stage or job preparation event |
| `POST /managed-rl/approvals` | Fold into quote/job approval or retain as private lease operation |
| `POST /managed-rl/launches` | Replaced by V2 job creation after migration |
| `POST /managed-rl/calibration-batches` | Keep temporarily; later model as evaluation/inference, not automatically training |
| `POST /managed-rl/serving-soaks` | Keep operator/private unless a public training validation use is established |

Existing routes remain operational until all OpenPond callers and active job
references have migrated and the removal gate passes.

## Ownership Matrix

| Concern | Public definition | Runtime authority |
| --- | --- | --- |
| Harness, Taskset, Dataset, Evidence refs | OpenPond | OpenPond authors; Sandbox verifies submitted hashes |
| Model Project, Job/Run, Version lineage | OpenPond SDK contracts | Portable client authors Project; Sandbox owns managed Job state |
| Job submission and status schema | OpenPond training protocol | Each implementing runtime |
| Recipe and reward-source schema | OpenPond | OpenPond selects; Sandbox validates support |
| Qualification policy and report | OpenPond | OpenPond or an explicitly selected evaluator |
| Capabilities schema | OpenPond | Sandbox reports its current capabilities |
| Provider and placement resolution | Not public beyond bounded capability facts | Sandbox |
| Job/resource state | Portable projection is public | Sandbox for managed jobs |
| Checkpoint/output schema | OpenPond | Sandbox stores and verifies managed bytes |
| Execution receipt schema | OpenPond | Sandbox signs managed receipts |
| Evaluation result schema | OpenPond | Selected evaluator measures; OpenPond interprets |
| Promotion/default/rollback | OpenPond | OpenPond/user |
| Metering and cleanup | Portable summary is public | Sandbox |

## Compatibility and Migration Invariants

The migration is additive until final removal:

- Do not modify active V1 job input bundles in place.
- Store the API/protocol route used by each execution reference so old jobs
  remain queryable, cancellable, collectible, and inspectable after V2 ships.
- Never launch both V1 and V2 paid jobs to compare behavior. Shadow comparison
  is limited to request projection, schema validation, hash comparison, and
  response projection until an explicitly approved bounded canary.
- V1 and V2 idempotency namespaces must resolve one user action to one managed
  job. A retry during rollout cannot create a second provider lease.
- Preserve current team scoping, optimistic job version checks, and cleanup
  reserve behavior.
- Preserve current artifact refs and legacy read paths for historical jobs.
  New V2 outputs may wrap them without rewriting stored bytes.
- Do not make OpenPond depend on Sandbox database rows, provider IDs, or worker
  commands.
- Do not make Sandbox call back into a running OpenPond desktop instance.
- Do not make the protocol require PRIME-RL, Prime Compute, Latitude, R2, GCP,
  or another provider by name.
- A failed V2 canary must be routable back to V1 for new jobs without affecting
  active V2 jobs or deleting their evidence.

## Phases

### Phase 0 - Freeze the working baseline

- [x] Record the exact current V1 request and terminal response fixtures for a
  portable policy job, Reward Model job, learned-reward policy job, local
  rollout claim/completion, cancellation, logs, events, artifacts, and cleanup.
- [x] Add or confirm focused tests for the OpenPond managed adapter, Reward
  Model launch projection, managed evidence persistence, qualification
  projection, and local rollout executor.
- [x] Add or confirm Sandbox tests for route authorization, service admission,
  portable launch, Reward Model launch, job lifecycle, learned reward, worker
  commands, artifact verification, and terminal cleanup.
- [x] Run the current Python managed-worker tests and record that the active
  trainer is the direct custom worker, not PRIME-RL. Done: the Python 3.12
  suite passed 40 tests against `policy_trainer.py`,
  `reward_model_trainer.py`, and `worker.py`; no PRIME-RL import or adapter is
  in the runtime.
- [x] Preserve the successful 2026-08-25 proof as the historical V1 baseline;
  do not spend on another provider run merely to begin contract work. Done:
  job `yiwa4qg7omxtxy0owes0os7s` remains the recorded V1 baseline and no paid
  replacement Run was launched during schema work.

Acceptance: the existing working flow has durable local fixtures and focused
tests that will fail if V2 changes its observable behavior accidentally.

### Phase 1 - Publish Model Project and training through the existing SDK

- [x] Add pure `openpond-sdk/model-projects` and `openpond-sdk/training`
  exports, package metadata, build entries, tests, and documentation without
  application-server, database, UI, provider, credential, or Node-only runtime
  dependencies. Done: both subpaths build as independent SDK entry points.
- [x] Define `ModelProject.trainingSetup` from the useful current
  `ModelRunDraft` fields: exact Taskset/Harness refs, base Model, method,
  destination, rollout placement, preset, recipe, and bounded approval inputs.
  Done: the Project owns one bounded current setup and the editor writes that
  setup directly; the transitional Draft write path has been removed.
- [x] Remove public Draft terminology. Migrate the local schema, store, server
  actions, hooks, and UI from multiple `ModelRunDraft` records to one current
  Project setup while preserving already-submitted Job/Run history. In
  Done locally: schema version 49 migrates the latest useful legacy setup into
  the Project, removes the Draft table, and all current preparation, launch,
  store, action, hook, and UI callers use Project-owned setup.
- [x] Delete Draft-only workflow fields that do not belong in durable Project
  state, including the hardcoded Draft title and Draft lifecycle status. Keep
  transient editor navigation in component state.
- [x] Add bounded `ModelProjectSummary` and `ModelProjectDetail` contracts that
  link separately stored Jobs, Versions, evaluations, and evidence without
  embedding unbounded history in the core Project record. Done: strict schemas
  and validated create/list/detail clients cover the bounded response envelope.
- [x] Prove serialization boundaries: Project payloads cannot contain Job logs,
  events, raw evidence, artifact inventories, or provider/worker state, and
  explicit approval authority is absent from mutable Project state. Done:
  negative SDK tests reject approval/runtime authority in Project sync.
- [x] Define mutable Project setup, immutable releases/Jobs/receipts, derived
  projections, and private operational state as schema and API invariants.
  Done: separate Project and Training schemas encode those boundaries.
- [x] Move or re-export shared primitives for immutable refs, Job submissions,
  Job state, events, logs, outputs, capabilities, errors, and execution receipts
  under `openpond-sdk/training`. Done: internal contracts import the public SDK
  definitions through explicit aliases instead of copying them.
- [x] Define `reward_model_train` and `policy_optimize` V2 job schemas from the
  currently working request payloads without dropping lineage. Done: the
  discriminated public Job request schema covers both kinds.
- [x] Define explicit compatibility rules, unknown-field behavior, maximum
  payload sizes, canonical hashing, and semantic version negotiation. Done:
  the released protocol module and `TRAINING_PROTOCOL.md` define strict
  envelopes, 512 KiB/1 MiB/8 MiB bounds, canonical UTF-8 SHA-256, media types,
  and V2 negotiation with positive and negative tests.
- [x] Publish positive and negative JSON fixtures plus canonical hashes.
- [x] Re-export the V2 protocol from `@openpond/contracts` so existing OpenPond
  code can migrate without duplicate local definitions. Done:
  `public-sdk-contracts.ts` supplies explicit public aliases.
- [x] Snapshot immutable submission lineage onto local Training Jobs before
  removing Draft persistence. Done: commit `7dd2b7c6` records the exact Project
  revision, Taskset/releases, Harness release, base Model, and method; terminal
  artifact import passes after the Draft row is deleted.
- [x] Document how external providers can implement and test the protocol.
  Done: the released `TRAINING_PROTOCOL.md` lists the provider routes,
  ownership rules, conformance procedure, fixtures, and receipt boundary.

Acceptance: OpenPond, a standalone fixture runner, and Sandbox can validate the
same bytes against the same released schema and canonical hashes.

### Phase 2 - Complete Project synchronization and shared Job visibility

- [x] Update Project upsert to validate the public
  `openpond-sdk/model-projects` sync contract and preserve portable ID,
  revision, ETag, team ownership, and source timestamps. Done:
  `lib/sandbox/model-projects/service.ts` parses the released V2 schema and the
  public edge returns only strict SDK projections.
- [x] Add SDK list/detail clients for hosted Projects and their bounded resource
  summaries. Done: all clients validate the complete response envelope.
- [x] Add a Project-filtered hosted Job collection and cursor so Desktop can
  show managed Jobs created through any authorized SDK/API client. Done:
  `/v1/training/jobs` filters hosted or portable Project ID and uses a stable
  descending `updatedAt`/Job-ID cursor covered by a service test.
- [x] On submission, sync the latest Project revision before creating the Job,
  bind the immutable Job to hosted and portable Project IDs plus source
  revision/hash, and refresh the hosted projection afterward.
- [x] Define conflict behavior explicitly: portable clients author Project
  revisions; hosted Job state never overwrites Project authoring fields. Done:
  exact retries are idempotent, updates require the current ETag and a strictly
  newer source revision, and stale/unversioned overwrites return conflict.
- [ ] Preserve current Taskset release publication and Project association while
  moving its duplicated schemas to the SDK contract.
- [x] Add tests for stale Project revisions, ETag conflicts, idempotent retry,
  cross-client Job visibility, and Project-scoped authorization.
- [x] Prove that Desktop Run history is a projection of the hosted Job identity
  rather than a second independently mutable Run status record.
- [x] Do not change Sandbox UI in this phase.

Acceptance: an SDK-authored Project can be saved from OpenPond, submitted once,
and refreshed to show the same hosted Job identity and status that the hosted
API returns, without a separate Draft resource or peer-to-peer state merge.

### Phase 3 - Add the Sandbox V2 protocol adapter

- [x] Pin a released `openpond-sdk` version in Sandbox, importing only the
  required pure subpaths, or consume its generated JSON
  Schema/fixtures through a reproducible release process. Done:
  `openpond-sdk@0.0.16` is an exact dependency and a clean ESM import verified
  both V2 schema versions.
- [x] Add `GET /v1/training/capabilities` backed by the authoritative Sandbox
  model, worker, method, resource, and reward-source matrix. Done: the strict
  canonical capability projection is derived from the acceptance contract and
  tested for its exact hash.
- [x] Add V2 job create/list/detail/cancel/events/logs/outputs routes as a thin
  adapter over the current service, store, and orchestrator. Done: the public
  handler reuses the existing service/control methods and strict SDK
  projections; route/auth/media tests pass.
- [x] Resolve the public V2 submission into a private Sandbox execution
  envelope containing provider, quote, worker, placement, lease, and storage
  facts. Done: service tests prove the policy V2 projection reaches the same
  private recipe, Taskset, Harness, Model, and runtime facts as V1 while
  applying the public wall bound.
- [x] Preserve the submitted OpenPond refs and content hashes verbatim in the
  durable job and terminal receipt. Done: additive Job columns retain the exact
  submission plus Project revision/hash and terminal receipt tests bind all
  input/output hashes.
- [x] Keep all V1 routes and worker protocols operational. Done: the focused
  V1 handler, admission, portable launch, orchestrator, worker-control,
  artifact, and 40-test Python worker suites remain green locally.
- [x] Add conformance coverage proving V1 and V2 reach the same internal job
  kinds and lifecycle states for equivalent fixtures.

Acceptance: a V2 fixture creates the same internal managed job and passes the
same admission, resource, artifact, and cleanup invariants as V1 without
changing the trainer or rollout runtime.

### Phase 4 - Add OpenPond V2 client projection without launching it

- [x] Replace hardcoded managed capabilities in
  `openpond-managed-training-adapter.ts` with the V2 capability document while
  retaining local safety bounds for malformed or unavailable responses.
- [x] Add an OpenPond V2 submission builder sourced only from the exact source
  Model Project revision, Harness, Taskset, Dataset, Evidence, recipe, approval,
  and reward bindings.
- [x] For existing test fixtures, project both V1 and V2 requests locally and
  compare their release graph, training data, recipe, budget, and expected
  outputs without launching duplicate jobs.
- [x] Store protocol version and route family on `TrainingExecutionRef`.
- [x] Cut new managed Job creation directly to V2 and bind that route family
  immutably on creation. Existing stored execution refs retain their recorded
  route family; no new product-facing V1 fallback was added.

Acceptance: OpenPond can construct and validate V2 requests, discover actual
Sandbox capabilities, and continue launching V1 only.

### Phase 5 - Migrate Reward Model training

- [x] Route a local mocked Reward Model launch through V2 and prove identical
  group membership, candidate JSON, buckets, train/validation partition,
  recipe, Model/processor refs, budget, and idempotency.
- [x] Return the checkpoint and complete inventory through V2 outputs.
- [x] Add a Sandbox-issued execution receipt binding input, recipe, worker, and
  checkpoint hashes.
- [x] Keep OpenPond's Reward Model Version and qualification-report projection
  unchanged except for consuming the new execution receipt.
- [x] Prove cancellation, malformed input, artifact mismatch, provider failure,
  and cleanup paths through V2.
- [x] Run one explicitly approved bounded staging Reward Model canary only after
  local parity passes.
  Done: V2 job `k6u5q1m8199gw9kvo66sa9eu` completed for USD 0.026868,
  returned a byte-verified checkpoint and complete inventory, projected
  separate managed execution-receipt and OpenPond qualification-report hashes,
  and terminated with every cleanup count at zero.

Acceptance: the V2 canary produces a reloadable scorer artifact and the same
OpenPond lifecycle records without using `/reward-model-launches`.

### Phase 6 - Migrate managed policy optimization

- [x] Route portable GRPO submission through `kind: policy_optimize` while
  preserving the exact Harness Run Manifest and resolved bundle hashes.
- [x] Preserve both local and remote Harness placement behavior.
- [x] Bind learned reward to the verified scorer artifact and Sandbox execution
  receipt while passing OpenPond Model Version and qualification refs through
  as lineage.
- [x] Prove rollout claim/completion, group barriers, reward projection,
  optimizer update, checkpoint reload, evaluation, stop-after-group,
  cancellation, and terminal collection.
- [x] Prove that synthetic, deterministic, learned, and other declared reward
  sources are admitted according to executable capability rather than a global
  human-versus-synthetic production rule.
- [x] Run one bounded Duck managed-RL V2 staging canary that creates and reloads
  a real Reward Model artifact, uses its frozen scorer in grouped Duck Taskset
  rollouts, commits one Policy optimizer update and checkpoint, evaluates the
  result, and proves terminal cleanup through the final public resources.
  Done: V2 policy job `roe0xyiyitkkhkl3lx5txfoy`, projected locally as
  `model_run_88e92f4a-ac51-4422-8c9e-26f7cdf34193`, consumed four eligible
  varying learned rewards, committed Policy Version zero to one, reloaded its
  checkpoint, passed frozen baseline/candidate evaluation, spent USD 0.056989,
  and returned zero live cleanup counts without exporting expected answers or
  privileged reward assets.

Acceptance: V2 completes the existing full learned-preference training smoke
with one real policy update, retained artifacts, observable evidence, bounded
spend, and zero live proof-owned resources.

### Phase 7 - Complete outputs and qualification separation

- [x] Make `OpenPondTrainingExecutionReceiptV2` the managed authority for job
  execution and artifact bytes.
- [x] Require a valid managed receipt when a later Sandbox job consumes a
  Sandbox-produced scorer or policy checkpoint.
- [x] Keep OpenPond qualification, Model Version, selection, promotion, and
  rollback operations in OpenPond.
- [x] Replace hosted binary `qualificationKind` admission with product-owned
  provenance and qualified-use references without discarding historical V1
  records.
- [x] Expose the execution receipt and OpenPond qualification report separately
  in Run and Version details so users can distinguish "what executed" from
  "what this result is suitable for."
  Done: Reward Model Run details render separate Execution receipt and
  Qualification report resources. Reward Model Version rows correlate their
  source Run and expose the checkpoint, managed execution receipt, OpenPond
  qualification report, and an explicit explanation of the authority split.

Acceptance: neither system trusts an arbitrary checkpoint ref, and Sandbox
does not become the semantic authority for OpenPond model readiness.

### Phase 8 - Retire specialized public V1 routes

- [ ] Inventory every OpenPond, Sandbox UI, CLI, script, staging proof, and test
  caller of the specialized routes.
- [ ] Stop creating new V1 jobs after V2 Reward Model and policy canaries pass.
- [ ] Preserve read, cancel, logs, events, artifacts, and cleanup support for
  historical V1 job references for the declared retention window.
- [ ] Remove V1 request builders and duplicated product schemas from Sandbox.
- [ ] Keep internal worker and orchestration APIs private and stable unless a
  separate operational migration requires changes.
- [ ] Update related working docs that currently describe Sandbox-authored
  OpenPond releases or a current PRIME-RL adapter.

Acceptance: all new managed training uses the public OpenPond V2 protocol,
historical V1 runs remain inspectable, and no specialized launch endpoint has a
live caller.

### Phase 9 - Run the full sixteen-step managed RL learning proof

Use the focused
[Sixteen-Step Managed RL Learning Run](../../../../sandbox/docs/working-docs/training/2026-08-26-sixteen-step-managed-rl-learning-run.md)
as the authoritative execution plan. This is the final sustained-learning
acceptance proof, not the first V2 canary. Do not start it merely because the
SDK package has published or the new route accepts a request.

- [ ] Confirm Phases 0 through 8 are complete, `openpond-sdk@0.0.13` or its
  later exact replacement is published and pinned in Sandbox, all local and
  cross-repository conformance gates pass, and the deployed staging commit is
  recorded.
- [ ] Re-resolve the exact existing Duck managed-RL Model Project revision,
  Duck Taskset and Harness
  releases, starting Policy Version, frozen synthetic-smoke Reward Model
  Version and managed execution receipt, recipe hash, worker image digest, and
  capability hash through the final V2 API.
- [ ] Run the focused document's zero-spend preflight and prove four distinct
  valid structured candidates plus non-zero within-group reward variance
  before authorizing provider compute.
- [x] Obtain explicit approval for exactly one idempotent managed Run with
  `maxSteps: 16`, group size `4`, `maxRollouts: 64`, no more than `7,200` GPU
  seconds, no more than `7,800` wall seconds, and a USD 9.99-or-lower spend
  ceiling accepted against a fresh quote with cleanup reserve. Done: the user
  explicitly approved the documented bounded proof spend on 2026-08-26; do not
  pause later solely to request the same approval again if these bounds remain
  unchanged.
- [ ] Launch the Run only through the final public V2 Training Job endpoint and
  bind it to the immutable source Project revision. Record the portable Run
  identity, hosted Job identity, submission/bundle hashes, approval, start
  time, and deployed commit without recording credentials.
- [ ] Prove all sixteen optimizer steps commit in order, with four-candidate
  rollout groups, varying learned reward, Policy Version transitions, parameter
  changes, loss, gradient norm, sampled KL, clip fraction, checkpoints, live
  events/logs, and bounded spend visible through the final projection.
- [ ] Prove final checkpoint reload and evaluation, immutable Model Version and
  output/receipt projection, correct terminal state, stopped timers, complete
  cleanup attestation, and independent zero-active-resource provider readback.
- [ ] Record the exact result in both working docs. A safely retained partial
  checkpoint is useful failure evidence but does not complete this phase; fix
  the owned defect before a bounded retry. The user's standing approval covers
  required canaries and retries within the documented per-Run ceilings, so do
  not stop solely for another approval prompt; never retry automatically or in
  parallel.

Acceptance: the released OpenPond protocol and final Sandbox control plane
complete one real sixteen-step learned-reward GRPO Run with sixty-four-or-fewer
candidate rollouts, sixteen immutable Policy transitions, retained telemetry
and artifacts, final evaluation, spend within approval, and zero proof-owned
live resources. This proves sustained optimization machinery, not human-taste
quality or production qualification.

### Deferred follow-up - Sandbox Model Project UI

Do not implement Sandbox UI changes as part of Phases 0 through 9. After the
SDK contracts, Project synchronization, shared Job visibility, and training API
plus the full learning Run are proven, write a focused product/UI plan that decides:

- whether to remove hosted Project creation and make portable clients the only
  authoring source;
- which Project fields, resource summaries, and Job history are view-only;
- which operational controls such as cancel, stop-after-group, logs, outputs,
  evaluation, deployment, and deletion remain hosted controls;
- whether any hosted authoring or collaboration is justified later.

The current decision is deliberately narrower: no Sandbox UI work now.

### Phase 10 - Evaluate additional trainer engines separately

- [ ] Measure whether the current direct trainer fails a scaling, asynchronous,
  multi-node, long-horizon, or model-support requirement.
- [ ] If justified, write a focused PRIME-RL adapter plan against an exact
  upstream release and the OpenPond engine conformance suite.
- [ ] Keep the current engine available until the new adapter passes equivalent
  rollout, optimizer, checkpoint, resume, cancellation, and cleanup proofs.
- [ ] Do not change the OpenPond V2 product protocol solely to mirror an
  upstream engine's internal configuration.

Acceptance: engine selection is capability-driven and independently proven;
the API cleanup is already complete whether or not PRIME-RL is added.

## Validation Plan

### OpenPond local gates

Run at minimum:

```text
pnpm --filter @openpond/contracts build
pnpm --filter openpond-sdk check
pnpm --filter @openpond/training-sdk test
pnpm exec vitest run \
  apps/server/src/training/model-project-hosting.test.ts \
  tests/learned-preference-training-contracts.test.ts \
  tests/reward-model-qualification-projection.test.ts \
  apps/server/src/training/reward-model-launch-input.test.ts \
  tests/openpond-managed-training-adapter.test.ts \
  tests/managed-rl-local-rollout-executor.test.ts \
  tests/portable-model-run-lifecycle.test.ts
pnpm typecheck
```

Add V2 protocol fixture, hashing, unknown-field, size-limit, version-negotiation,
capabilities, output, receipt, and V1/V2 projection tests before the relevant
phase is checked.

### Sandbox local gates

Run at minimum:

```text
bun test \
  deployment-worker/api/handlers/managed-rl-handler.test.ts \
  deployment-worker/domain/services/managed-rl/service.test.ts \
  deployment-worker/domain/services/managed-rl/portable-launch.test.ts \
  deployment-worker/domain/services/managed-rl/training-orchestrator.test.ts \
  deployment-worker/domain/services/managed-rl/worker-control.test.ts \
  deployment-worker/domain/services/managed-rl/learned-reward-source.test.ts \
  deployment-worker/domain/services/managed-rl/artifact-store.test.ts \
  lib/sandbox/managed-rl/portable-submission.test.ts \
  lib/sandbox/managed-rl/admission.test.ts
python -m unittest discover -s managed-rl-worker -p 'test_*.py'
bun run typecheck
```

Add tests that consume the released OpenPond fixtures directly. A copied
fixture is insufficient unless CI verifies its release identity and canonical
hash against the released `openpond-sdk` version.

### Cross-repository conformance

For every shared positive fixture:

- OpenPond and Sandbox accept the same canonical bytes;
- both calculate the same content hash;
- Sandbox resolves the expected internal job kind;
- status and outputs round-trip through the public schemas;
- OpenPond can persist and resume the execution reference;
- V1 and V2 projection preserve the same Harness, Dataset, Evidence, recipe,
  reward, budget, and output lineage.

For negative fixtures, both surfaces reject the same structural failures, while
Sandbox alone may add operational admission errors such as capacity, quote,
tenancy, provider, or budget unavailability.

### Staging proof gates

No paid proof runs during the schema-only phases. Each provider-backed canary
requires the established authenticated staging workflow, an explicit spend
ceiling, idempotency key, cleanup reserve, and terminal zero-resource check.

The bounded V2 migration canaries must demonstrate:

- capability discovery before launch;
- one V2 Reward Model job;
- reload and managed scoring of its exact returned artifact;
- one V2 policy-optimization job using that scorer;
- at least one committed policy update and reload;
- logs, metrics, events, trajectories, outputs, and both receipt types visible
  in OpenPond;
- cancellation exercised in a separate bounded fixture or previously proven
  equivalent route;
- no duplicate jobs across retry/reconnect;
- final provider spend within approval;
- zero remaining provider, sandbox, reservation, capability, and temporary
  upload resources.

After those canaries and all migration phases pass, Phase 9 is the final
staging acceptance proof. It must use the same released V2 contracts, the Duck
managed-RL Model Project/Taskset, and the final route family while completing
sixteen committed GRPO updates over
four-candidate groups, retaining all Policy transitions and telemetry, reloading
and evaluating the terminal checkpoint, staying within its separately approved
USD 9.99-or-lower ceiling, and independently proving zero live proof-owned
resources. The focused sixteen-step document owns the detailed monitoring and
failure-evidence procedure. Publishing the SDK alone is not authorization to
start this paid Run.

## Rollback Plan

- V2 creation is feature-gated independently for Reward Model and policy jobs.
- Existing V1 jobs always continue through their stored V1 route family.
- A failed V2 canary disables only new V2 creation; it does not mutate or
  delete V2 evidence.
- OpenPond retains the V1 projection until both V2 canaries and the historical
  read/cancel/collect compatibility tests pass.
- Sandbox retains V1 handlers until route telemetry and source inventory prove
  that there are no new callers.
- Database migrations must be additive through V2 rollout. No destructive
  column or table removal occurs in the same release that disables V1 create.
- A failed or partial sixteen-step Run never retries automatically. Preserve
  its terminal evidence and latest valid checkpoint, prove cleanup, and fix the
  owned defect before another bounded attempt. Standing user approval covers
  necessary retries within the documented per-Run ceiling, but does not permit
  duplicate launches, a higher ceiling, or overlapping paid attempts.

## Boundaries

- Do not implement the migration from this planning document alone without
  first completing Phase 0, inspecting both working trees, and preserving
  unrelated user changes.
- Do not add or claim a PRIME-RL adapter as part of this API cleanup.
- Do not create `@openpond/model-project` or another npm package while the
  dependency-light `openpond-sdk` subpaths satisfy the public boundary.
- Do not preserve `ModelRunDraft` as a public or user-facing concept. Preserve
  submitted history as immutable Jobs and keep one current setup on Project.
- Do not redesign, remove, or expand Sandbox UI controls in this implementation
  pass. Record that work in the deferred follow-up after API proof.
- Do not fork PRIME-RL, TRL, veRL, Transformers, PEFT, or another trainer.
- Do not move provider credentials, placement rules, lease tokens, or private
  operational state into OpenPond.
- Do not move qualification, Model promotion, or default selection authority
  into Sandbox.
- Do not remove OpenPond domain references merely to make the API look generic.
- Do not add human-held-out requirements to reward sources whose intended
  objective is synthetic, deterministic, environmental, or otherwise
  non-human.
- Do not launch paid or destructive staging operations without explicit
  approval and the cleanup process. The user has approved the documented Duck
  managed-RL canaries and single sixteen-step Run within their stated hard
  ceilings; quote, admission, idempotency, and cleanup checks still fail closed.
- Do not start the sixteen-step learning Run until Phases 0 through 8, the
  released SDK pin, local/cross-repository conformance, bounded V2 canaries, and
  exact staging deployment readback are complete. Its documented spend
  approval is already recorded; do not widen the ceiling or launch duplicates.
- Do not preserve legacy launch paths beyond their migration/read-retention
  purpose; this WIP product does not require permanent fallback branches after
  the removal gate passes.

## Open Questions

- Should the signed-in route remain `/v1/training` with schema-versioned bodies
  or move to `/v2/training`? Choose based on the existing public API versioning
  convention, not aesthetic preference.
- Is preference calibration best represented as an OpenPond Evaluation Job, a
  generic managed inference job, or a retained specialized operation?
- Which artifact upload protocol should replace bounded inline base64 first:
  presigned multipart upload, content-addressed single-object upload, or both by
  size class?
- Should managed execution receipts use a detached asymmetric signature in V2,
  or an authenticated immutable hosted receipt reference initially? The schema
  should permit verification without exposing Sandbox signing internals.
- What is the required historical V1 read/cancel/collect retention window after
  new V1 creation stops?

## Progress Log

- 2026-08-27: Passed the public V2 migration canaries. Reward Model job
  `k6u5q1m8199gw9kvo66sa9eu` produced a byte-verified scorer checkpoint,
  immutable Reward Model Version, OpenPond qualification report, Sandbox
  execution receipt, and zero-resource cleanup for USD 0.026868. Policy job
  `roe0xyiyitkkhkl3lx5txfoy` consumed that exact receipt-bound scorer in four
  eligible Duck rollouts with non-zero reward variance, committed and reloaded
  Policy Version one, passed frozen evaluation, and cleaned up for USD
  0.056989. The managed payload contained no expected answer, renderer/reward
  asset, or privileged filesystem content. Run and Reward Model Version details
  now render execution receipts separately from product qualification reports;
  commit `2f2d5104` is on PR #192. OpenPond passes typecheck, structure,
  reachability, and 439 files / 2,193 passing unit tests with one skip.

- 2026-08-27: The first sustained V2 proof identified capacity selection, not
  protocol or cleanup, as the remaining owner. A40 job
  `gwrk2kbtfj6aqrtzzbsuqdh2` safely retained three ordered updates and its
  latest valid checkpoint after a graceful deadline stop, spent USD 0.398475,
  passed candidate evaluation, and cleaned up to zero. Later H100 NVL and H100
  PCIe listings failed before pod creation at USD 0 with terminated leases and
  no rollout or artifact. Sandbox now admits the exact requested budget
  components and chooses a deadline-capable, affordable H100 HBM3 training
  shape for the next non-overlapping retry. Local managed-RL and Python worker
  suites pass; the staging rollout is waiting on interactive renewal of the
  operator's expired Google deployment credential.

- 2026-08-27: Published `openpond-sdk@0.0.16` from successful Release SDK run
  `33045862109` and pinned it exactly in Sandbox. Completed the local OpenPond
  cutover from `ModelRunDraft` to Project-owned training setup and final V2
  artifact/Job clients for Reward Model and policy training. Sandbox now stages
  bounded immutable portable and Reward Model inputs, resolves them by exact
  hash, projects scorer evidence/inventory through V2 outputs, and rejects
  learned-scorer reuse without the exact managed execution receipt. Removed
  binary qualification kind from Sandbox admission; OpenPond retains the
  qualification report as product provenance. Evidence: OpenPond typecheck,
  SDK checks, and 440-file / 2,194-test unit suite pass; Sandbox typecheck,
  224 managed-RL tests, and 40 Python 3.12 worker tests pass. No paid compute
  launched; final deployment and canaries remain.

- 2026-08-27: Generated and applied Sandbox migration
  `0102_last_vertigo` through the repository CLI and the staging Cloud SQL
  automatic-IAM connector. Fixed two release-only dependency boundaries found
  by the fail-closed image build: the isolated deployment-worker manifest now
  pins `openpond-sdk@0.0.14`, and its exact `esbuild@0.28.1` lifecycle is
  allowlisted by the nested supply-chain policy. Released source SHA
  `fce02383` as immutable digest `sha256:a066ede602e4ca740bac8d278340432aa569bd630cf2ea139f39e34a8a380104`,
  committed the digest pin at `6cd713f8`, and deployed a Ready staging frontend
  from that commit. The hot rollout canary reported private-only VM, protected
  disk, immutable containers, zero restarts, and Cloud SQL query readiness;
  GCP and Cloudflare verification report zero drift. Live perimeter probes
  returned health `200`, unauthenticated capabilities `401`, unauthenticated
  Model Projects `401`, and unknown V2 path `404`. No paid compute launched.
- 2026-08-27: Published `openpond-sdk@0.0.14`, pinned it exactly in Sandbox,
  and proved clean Bun imports of both public subpaths. Implemented the first
  Sandbox V2 adapter slice on `develop`: strict media/version handling, exact
  synchronized Project revision/ETag admission, immutable submission storage,
  Project cursor pagination, portable-manifest byte revalidation, V1/V2 policy
  projection parity, candidate artifact verification, terminal output and
  authenticated hosted receipt projection, and receipt-required managed scorer
  reuse. Focused TypeScript suites and typecheck pass; the direct Python 3.12
  worker suite passes 40 tests after deterministic source-release regeneration.
  Migration generation/deploy, OpenPond V2 client/Draft cleanup, bounded
  canaries, V1 create retirement, and the final Run remain. No paid compute
  launched.
- 2026-08-27: Published `@openpond/harness@0.2.5` after PR #187 passed its
  complete package and consumer checks. OpenPond PR #188 now hardens the public
  V2 protocol and fixes the SDK's published runtime dependency. Local evidence:
  `pnpm --filter openpond-sdk check` passed 26 SDK tests, canonical positive and
  negative fixtures, both builds, clean tarball installation and public
  subpath imports, and package dry-run. The first CI attempt failed before tests
  solely on the repository's minimum-release-age policy; an exact first-party
  version exception was added and a fresh run is in progress.
- 2026-08-26: Removed the earlier stage-letter shorthand from this migration
  plan. The regression and final proof now name concrete preference
  datasets, Reward Model Jobs/checkpoints/scorers, Duck rollout groups, Policy
  optimizer updates/checkpoints, evaluations, receipts, and cleanup evidence.
  Recorded the user's explicit approval for the bounded Duck managed-RL
  canaries and one sixteen-step Run within the documented ceilings; later work
  must not stop solely to ask for the same unchanged approval again.
- 2026-08-26: Added the focused sixteen-step managed GRPO learning Run as Phase
  9 and the final post-migration acceptance proof. It remains gated on the
  published SDK pin, completion of Phases 0 through 8, all conformance gates,
  bounded V2 canaries, exact staging deployment readback, and a separate spend
  approval. No Run was started. The existing one-step V2 canaries remain cheap
  transport/lifecycle prerequisites and do not substitute for sixteen
  committed Policy transitions.
- 2026-08-26: Implemented the first OpenPond slice on PR #184. Added public
  `openpond-sdk/model-projects` and `openpond-sdk/training` entry points,
  Project-owned training setup, strict Project/Job boundaries, SDK clients,
  internal public-contract aliases, and immutable local Job source snapshots.
  Commit `7dd2b7c6` proves terminal artifact reconciliation without the old
  Draft row. Validation passed with `pnpm --filter openpond-sdk check` (24 SDK
  tests, build, package dry run), 16 focused training tests, and
  `pnpm typecheck`.
- 2026-08-26: Established a hard cross-repository release gate. Merge PR #184,
  run `pnpm release:sdk:patch` from clean current `master`, merge the generated
  release PR to publish `openpond-sdk@0.0.13`, and only then add the package to
  Sandbox. Removed the partial local Sandbox contract/schema edits so Sandbox
  remains unchanged apart from unrelated pre-existing working-doc edits.

- 2026-08-26: Confirmed that OpenPond is the open-source product and protocol,
  while Sandbox is its managed execution implementation. Corrected the earlier
  over-separation that would have removed useful OpenPond domain references
  from the managed API.
- 2026-08-26: Audited the current route surface and confirmed that specialized
  portable, Reward Model, and calibration launches converge on Sandbox's
  existing durable job creation path.
- 2026-08-26: Confirmed that no executable PRIME-RL adapter exists in the
  current OpenPond source and that the active Sandbox worker uses direct custom
  policy and Reward Model trainer modules. PRIME-RL remains an external
  architectural example and possible later engine adapter.
- 2026-08-26: Preserved the documented successful synthetic learned-preference
  run as the migration baseline and made a full V2 provider-backed reproduction
  a final acceptance gate rather than a prerequisite for schema work.
- 2026-08-26: Initially replaced the proposed standalone Training Protocol
  package with `@openpond/model-project` and kept Model Run Draft as the
  approved input to immutable Jobs. This decision was superseded later the same
  day by the simpler existing-SDK and single-Project-setup decision below.
- 2026-08-26: Audited the actual Project and Taskset editors. Project authoring
  currently exposes only name, objective, optional starting Model, and limited
  defaults, while `ModelRunDraft` stores the working training configuration.
  Taskset scenarios, frozen-eval splits, environments, graders, fixtures, human
  review, and aggregation are already editable rather than globally hardcoded.
- 2026-08-26: Confirmed the current partial synchronization path: Desktop
  upserts portable Projects, publishes Taskset releases, and includes the
  hosted Project ref in managed submissions; Sandbox stores team-scoped
  Project/Job projections. Desktop does not yet pull the full hosted Job
  collection for cross-client visibility.
- 2026-08-26: Finalized the current decision. Use
  `openpond-sdk/model-projects` and `openpond-sdk/training`; do not create a new
  package. Move one current training setup onto `ModelProject`, remove
  `ModelRunDraft` terminology/storage/UI, and snapshot each submission into an
  immutable Training Job bound to Project revision and hash. Complete API/SDK
  synchronization and shared Job visibility, but defer all Sandbox UI changes.
- 2026-08-26: Added holistic architecture guardrails: keep Project bounded,
  treat hosted Job as the durable Run identity, define portable SDK clients as
  authoring authority, keep managed execution state hosted, capture approval
  per Job, retain distinct immutable resource identities, and require concrete
  workflow evidence before adding parallel saved configurations.
