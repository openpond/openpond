# OpenPond Training Protocol V2

`openpond-sdk/training` and `openpond-sdk/model-projects` are the portable,
provider-neutral contract for OpenPond managed training. Providers implement
these resources without importing the OpenPond application server or exposing
their placement, worker, lease, credential, or storage internals.

## Compatibility rules

- Send and accept `application/vnd.openpond.training+json;version=2` for
  Training resources and `application/vnd.openpond.model-project+json;version=2`
  for Model Project resources. Reject unsupported major versions with a
  versioned API error and HTTP 406 or 415.
- Public resource envelopes are strict. Unknown fields are rejected. The two
  intentionally extensible locations are versioned recipe documents and event
  `data`; a provider must preserve recipe fields it does not interpret and
  reject a recipe version it cannot execute.
- A Training Job submission is at most 1 MiB of canonical JSON. Model Project
  sync is at most 512 KiB. SDK responses are bounded at 8 MiB. A staged input
  artifact envelope is bounded at 64 MiB and is stored by hash before Job
  admission; Jobs carry only immutable, content-addressed artifact references.
- `contentHash` on `openpond.trainingJobSubmission.v2` is lowercase SHA-256 of
  the canonical JSON object with the top-level `contentHash` member omitted.
  Canonical JSON sorts object keys, preserves array order, rejects non-JSON and
  non-finite values, and encodes UTF-8 bytes.
- A repeated idempotency key for the same team and identical submission hash
  returns the original Job. Reusing the key with different bytes is a conflict.
  Project revisions use optimistic ETags; a stale Project author must refresh
  before overwriting mutable authoring fields.
- Jobs, events, outputs, and receipts are immutable history. Cancellation and
  stop-after-group require the caller's observed Job version. Hosted Job state
  never overwrites mutable Project authoring fields.

## Required provider routes

`ModelProjectConfigurationCheckSchema` describes a read-only configuration check.
Its `configurationHash` covers the editable Model and expected revision through
`modelProjectConfigurationHash`; `canSave` and bounded findings describe the
server's resource checks at `checkedAt`. Deferred base-model and Taskset choices
are explicit. This receipt does not certify training readiness, Reward quality,
or candidate performance and does not authorize compute. Desktop exposes the
check at `POST /v1/training/models/check` with a `ModelProjectSaveRequest` body.
Hosted configuration checking is adopted separately from the V2 sync routes.

```text
GET  /v1/training/capabilities
POST /v1/training/artifacts
POST /v1/training/jobs
GET  /v1/training/jobs?modelProjectId=&cursor=&limit=
GET  /v1/training/jobs/{jobId}
POST /v1/training/jobs/{jobId}/cancel
POST /v1/training/jobs/{jobId}/stop-after-group
GET  /v1/training/jobs/{jobId}/events
GET  /v1/training/jobs/{jobId}/logs
GET  /v1/training/jobs/{jobId}/outputs

PUT  /v1/model-projects/{portableProjectId}
GET  /v1/model-projects
GET  /v1/model-projects/{projectId}
```

Every route is authenticated and team-scoped. `POST /artifacts` stages bytes
or an executable portable bundle without creating compute or a Job; retrying
the same idempotency key and hash returns the original artifact. The provider
stores the exact
portable Project ID, source revision/hash, Harness/Taskset/Dataset refs,
submission hash, and approval/budget facts. It resolves those public facts to
private execution state only after validation and admission.

`GET /outputs` returns `openpond.trainingJobOutputs.v2`, containing immutable
output refs and a provider-issued execution receipt. The receipt binds the
submission, manifest, recipe, capability document, runtime release, all input
and output hashes, duration, spend, issuer, and cleanup result. It attests to
execution and artifact bytes; OpenPond remains responsible for evaluation,
qualification, selection, promotion, rejection, and rollback semantics.
Output resources may include bounded provider-neutral `metadata`, such as a
checkpoint inventory or qualification metrics, when the portable client needs
that evidence to validate the artifact. This metadata is immutable output
evidence, not private worker-control, lease, or provider state.

## Deterministic grading identity

For portable training bundles, derive `job.rewardSource` with
`deterministicTrainingRewardSource({ graders, rewardExecution })` from the
verified bundle's `graders.json` and optional `reward-binding.json`. The grader
reference identifies the entire ordered set, including configuration, using the
canonical hash of `{ schemaVersion: "openpond.trainingGraderSet.v1", graders }`.
Its ID is `training-graders-` followed by the first 32 hash characters.

When a Reward binding exists, the helper compiles its verified releases to the
executed grader set and uses the binding's immutable ID/hash as `composer`.
This pins role, normalization, membership, weights, required sources and hard
gates even when those changes leave grader code unchanged. An unbound plan has
a null composer. Providers must recompute both references from the admitted
bundle before provisioning and retain both in receipt inputs when non-null.
Identity validation does not establish that a provider can execute a grader;
providers must also reject unsupported execution configurations at admission.

## Held-out evaluation source

Managed policy training carries `evaluation-source.json` inside the verified
resolved bundle. `TrainingEvaluationSourceSchema` describes its exact Taskset
revision, complete held-out task records and evaluator-only asset bytes.
`assertTrainingEvaluationIsolation` rejects train/held-out split violations,
duplicate task IDs and shared training/evaluation families. The data remains
private to evaluation and must not become policy-visible context.

`trainingEvaluationSourceRef` derives `source.evaluation`: the original Taskset
reference and the canonical evaluation dataset hash. Providers compare these
references with the admitted bundle before provisioning and retain both in
receipt inputs. Changing private answers or assets changes the bundle and
evaluation dataset identity. Model configuration may select a separate immutable
`evaluationTasksetRef`; a train-only batch does not need a Comparison Series.

The nullable wire field preserves historical records. A provider that requires
pinned evaluation must reject new policy submissions without it. Artifact
admission alone does not establish model execution or learning quality.

## Conformance

Published fixtures live in `fixtures/training/v2`. Providers should:

1. validate `policy-optimize.valid.json` with
   `parseAndVerifyTrainingJobSubmission`;
2. reject the published unknown-field mutation;
3. run the same fixtures through their HTTP admission adapter;
4. prove authorization, idempotency, stale-version control, terminal outputs,
   receipt verification, and cleanup in provider-local tests;
5. compare V1 and V2 only at projection/admission time until a bounded V2
   canary is explicitly approved—never launch duplicate paid Jobs.

The package's `check` command validates schemas, fixtures, canonical hashes,
the built entry points, and a clean npm-style consumer install.

### Candidate review decisions

`training.recordCandidateDecision(request)` records an explicit `accepted` or
`rejected` review of one immutable adapter output. The request pins the team,
Job, adapter, retained candidate evaluation and terminal execution receipt, plus
a nonempty reason and idempotency key. `expectedDecision: null` means no prior
review; a later review supplies the prior decision's `{ id, contentHash }`.
The service must serialize this comparison with the write. The same idempotency
key and payload returns the same record; conflicting payloads or a stale prior
decision fail with a conflict rather than overwriting history.

`training.candidateDecision({ teamId, jobId, artifact })` reads the latest review
or null. Pass `{ decision: { id, contentHash } }` as the second argument to read
a specific historical entry, and follow `request.expectedDecision` to traverse
older reviews. Each result includes the authenticated actor, timestamp, revision
and content hash. The SDK verifies the requested owner/artifact and, for writes,
the entire submitted review. Hashes detect content changes; authorization comes
from the authenticated hosted resource, not a detached signature.

The endpoints are `GET` and `POST`
`/v1/training/jobs/:job/candidates/:artifact/decision`; historical GET uses
`?decisionId=...`. These contracts require candidate-decision service support.
Acceptance and rejection retain the original training/evaluation receipts. They
do not launch inference, change a serving binding, or bypass serving eligibility.

## Shared training bundle preparation

`openpond-sdk/training-bundle` exports `buildTasksetTrainingBundle` and the
runtime, compute, engine, run-manifest, and resolved-bundle schemas. Desktop and
hosted workers use this compiler with the same pinned Model, Taskset, Harness,
Reward, evaluation source, and asset bytes. It produces an immutable manifest
and an in-memory asset map without creating a training job or acquiring compute.

The compiler verifies selected release identities and private verifier bytes,
checks training/evaluation isolation, and rejects missing or unexpected Work
assets. Callers retain responsibility for authorizing the inputs and staging the
result through the training artifact API before job admission. Filesystem cache
materialization remains a Desktop concern.

The same entry point exports `materializeLearningBatchTaskset`. It verifies a
sealed learning batch and its evidence, admission decisions, Reward releases,
and verifier assets, then returns the authored Taskset, portable release, and
generated verifier files consumed by training preparation.

`prepareReviewedLearningBatch` applies the shared evidence privacy scan before
that projection. Both clients use it to construct training-source provenance
from the actual scan and sealed admission decisions.

`prepareManagedTrainingSubmission` constructs the staged portable artifact and
public policy-optimization Job from the approved manifest, recipe, exact file
inventory, held-out source and synchronized Model. It verifies the selected
bytes and budget, copies its inputs before hashing, and performs no network
requests. A hosted iteration supplies its durable dispatch id as
`idempotencyKey`; manual training retains its manifest-derived identity. The
caller stages the returned `artifact` and creates the returned `submission`
through the existing training client.

Before approval, `withAuthoritativeRecipeHashes(taskset, recipe)` binds the
selected Taskset and graders into the executable recipe. This is the same
projection used by Desktop for GRPO, PPO and DPO, including GRPO optimizer
semantics and bounded resource defaults. Validate the result with the applicable
recipe contract, then retain that exact recipe through approval and submission.
The shared `AdamwOptimizerConfigSchema` supplies the existing optimizer defaults.

`createPolicyHarnessContext` compiles the Agent snapshot and Harness release
from resolved immutable source, skill and agent dependencies. Desktop and hosted
preparation use the same compiler. For Taskset-owned training, supply the pinned
Taskset's source release (or `null`) without personal Profile dependencies.
An explicitly selected Harness continues to use its verified source package.
The compiler preserves existing release hashes and rejects dependencies whose
visibility is not `policy`; environment, task tools and graders remain bound by
the Taskset and training bundle.

## Published Harness source

`createTrainingClient().publishHarnessSource(sourcePackage)` publishes a verified, portable, policy-visible `@openpond/harness` source package to the authenticated workspace without starting a Job. `getHarnessSource({ id, contentHash })` retrieves and verifies that exact release. The endpoints are `PUT` and `GET /v1/training/harness-sources/:releaseId/:contentHash`; they use the existing Training media type and read/write scopes.

Hosted learning resolves this immutable source with Desktop closed. Publish before selecting the release on a hosted Model. Preparation still checks the Taskset adapter, required tools, private grading boundary and effective context; publication is not training or quality qualification. Existing prepared Jobs retain their captured source when a newer release is published.
