# Task evidence and reusable Rewards

`@openpond/evals/learning` owns the portable data and domain rules for task
definitions, sources, submissions, feedback, admission, immutable task batches,
learning policies and grading jobs. `@openpond/evals/rewards` owns immutable
Reward releases and exact versioned bindings. The package does not contain a
database, credentials, cloud client or execution infrastructure.

Use `openpond-sdk/learning` to submit the same commands to an authenticated local
or hosted execution owner. Plain HTTP producers use `POST /v1/learning/commands`
with `{ "scope": "<profile-or-team>", "command": { ... } }` and a Bearer token.
Reads use `POST /v1/learning/read`. Scope is a requested ownership boundary; the
host must authorize it from the credential and assign the actor itself.

Task-schema authoring uses a precompiled JSON Schema 2020-12 meta-validator plus
the bounded keyword/reference checks. Parsing definitions in a browser requires
no runtime code generation and works under a Content Security Policy without
`unsafe-eval`. The execution owner separately compiles schemas when validating
submitted values; schema publication alone is not evidence that an example passes.

Browser review uses `client.inspectEvidence({ id, revision, contentHash })`, or
the read payload `{ "action": "inspect_evidence", "scope": "<profile-or-team>",
"evidence": { "id": "...", "revision": 1, "contentHash": "..." } }`. The
execution owner checks the exact stored evidence and task definition and returns
their references with task readiness, observed-output validity and schema issues.
Source-only credentials cannot inspect evidence. Inspection is read-only; grade
and approval operations still validate their authoritative inputs independently.

## Data flow

1. Publish a Reward, then a binding, task definition and source. Use
   `publish_resources` to publish dependent resources atomically. Pin an existing
   release by `{ id, revision, contentHash }`; edits create the next revision with
   an expected current revision.
2. Submit task examples under a stable source/example/attempt identity. Preserve
   the producer idempotency key on retries. Reusing a key with different content
   fails with a conflict. Invalid task-specific evidence remains reviewable;
   accepting the submission does not approve it for training.
3. Queue durable grading of the observed output or a proposed supervised target.
   Hosts execute the binding through `TaskGradeExecutor`; the built-in executor
   supports portable deterministic checks and reports other implementations as
   unavailable. Publication and schema validity are not execution receipts.
4. Record a reviewer decision referencing completed grader-run IDs. The service
   checks the exact task, evidence, binding and output hashes. A failed observed
   response may reveal a valid task. Supervised learning additionally requires a
   separately approved, schema-valid target whose required checks passed.
5. Seal reviewed evidence into a batch. The service reserves both task-family and
   exact-input identities across splits in the same transaction. Unresolved
   families, stale evidence, stale decisions and held-out/training overlap fail.
   `compileTaskBatch` creates the existing `openpond.tasksetRelease.v2` package.

Observed output, verifier expected output, private evaluator context and an
approved supervised target have separate fields. The public policy view excludes
expected output and private context. Compiled packages retain the approved target
in typed learning metadata for a training adapter; they do not replace verifier
ground truth with a demonstration.

Feedback addresses source/example/attempt identity and may arrive before the
example. Input, ground-truth and family corrections create new evidence revisions.
Existing batches retain their exact historical evidence. Proposed-target feedback
must be graded and reviewed before becoming a supervised target.

## JSON and schema profile

Generated HTTP/producer schemas are in `schemas/learning/v1`. They describe the
structural contract. Use the domain service for authorization, revision/hash
identity, admission and transactional constraints; JSON Schema alone cannot prove
those relationships. Input/output schemas use object envelopes and JSON Schema
2020-12 through Ajv, with a bounded portable profile:

- Local `#/$defs/...` references; no remote loading or recursive schemas.
- No regex, formats, custom keywords or runtime code inside schema validation.
- At most 32 KiB of schema, bounded expansion/alternatives and validation caches.
- Plain JSON values, finite numbers, no accessors/serializers/cycles, bounded depth,
  node count and UTF-8 bytes. Host request limits apply in addition to field limits.

This profile follows [Ajv's security guidance](https://ajv.js.org/security.html)
for untrusted schemas and deliberately rejects unsupported capabilities.

## Host responsibilities

Authored verifier code and rubrics use immutable `asset` resources. Publish source
and its Reward with `publish_resources`; the service checks UTF-8 size, SHA-256,
full reference identity, scope and evaluator visibility in the same transaction.
Editing source creates a new asset identity. Existing Rewards retain their bytes.

`@openpond/evals/javascript-verifier/node` executes ESM verifier source in a
worker containing a fresh QuickJS WebAssembly interpreter. The verifier receives
JSON data and returns `{ score, passed, feedback, evidenceRefs? }`. It has no host
functions or import loader. Memory, stack, source/result sizes and execution time
are bounded; cancellation settles only after the worker has terminated. The
interpreter and worker are embedded in the package, so a clean install needs no
separate WASM download or native compiler. Browser/worker hosts can use the
portable `@openpond/evals/javascript-verifier` entry point directly.

This boundary follows the [QuickJS runtime isolation and resource APIs](https://github.com/justjake/quickjs-emscripten).
Node's [VM documentation](https://nodejs.org/api/vm.html) explicitly excludes
untrusted-code isolation; the local Taskset adapter now uses the same public
interpreter worker as task-evidence grading.

Implement `LearningRepository.transaction` with serialized writes and atomic
rollback. Persist immutable historical revisions, exact operation receipts and
unique split reservations. Never share a transaction object after it closes.
List results are cursor-paginated at no more than 100 resources.

Authorize every operation. Source credentials can submit only to their assigned
source; human admission/correction/sealing require a reviewer. Derive identities
from authentication, never from a producer-supplied actor field.

Grading workers use leases, stable job identity, bounded timeout/spend and terminal
receipts. Execution adapters must deduplicate submission and confirm cleanup.
Cancellation remains `cancelling` until the execution owner confirms termination;
a UI cancellation request is not proof that compute stopped. Restart recovery
must use the same durable jobs. Unexpected host failures remain server errors;
`LearningDomainError` exposes rejected requests as typed 4xx failures.

Policy and iteration contracts distinguish training parent, optional teacher and
upstream trigger. The contracts themselves do not launch training, schedule jobs,
qualify a model, accept a candidate or promote a serving endpoint. Hosts must
implement those transitions and record actual execution/evaluation receipts.
