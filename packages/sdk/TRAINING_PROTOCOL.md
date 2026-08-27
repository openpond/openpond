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
