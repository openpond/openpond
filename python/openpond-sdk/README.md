# Ponder Python SDK

Native synchronous and asynchronous access to existing OpenPond training,
evaluation, dataset and continual-learning APIs. Python3.10+; no Node subprocess,
Desktop application, or uv installation is required to use the installed wheel.
Distribution `ponder-sdk`, import `ponder_sdk`, candidate version0.1.0. Name and
publisher ownership must be verified before publication; this source is not a
claim that a registry release exists.

```sh
pip install ponder-sdk==0.1.0
# or: uv add ponder-sdk==0.1.0
```

Use an existing workspace API credential and explicit API origin. Do not put
credentials in source or request URLs. The SDK does not perform a second login.
For the official CLI use the running app's configured OpenPond home as described
in the repository configuration guide; the SDK accepts the credential explicitly.

```python
from ponder_sdk import Client, inputs

with Client(base_url="https://staging-api.openpond.ai", api_key=api_key,
            team_id=team_id) as client:
    capabilities = client.training.capabilities()
    # review is an existing reviewed batch and a pinned Model configuration.
    request: inputs.TrainingPreparationRequest = {
        "schemaVersion": "openpond.trainingPreparationRequest.v1",
        "teamId": team_id, "operationId": operation_id, "projectId": project_id,
        "configuration": configuration, "batch": reviewed_batch,
        "name": "Reviewed training", "maximumSpendUsd": approved_spend,
    }
    prepared = client.training.prepare_run(request)
    # Keep the receipt. Start is a separate explicit mutation after review.
    # client.training.start_preparation(prepared["plan"]["id"], {
    #     "teamId": team_id, "planHash": prepared["plan"]["contentHash"],
    #     "expectedRevision": prepared["revision"],
    # })
```

Every resource group has matching `AsyncClient` methods and owns the same native
HTTP pool. Use `async with AsyncClient(...)` and await calls. Close a client when
finished; cancellation of an async call propagates normally and closes its
response stream. If cancellation or transport loss occurs during a write, its
outcome may be unknown: retain the original operation/idempotency key and read the
existing operation/preparation/job before deciding whether to explicitly replay.
Writes are never automatically retried. GET reads retry at most3times for bounded
transport/408/429/selected5xx failures, with250/500ms backoff. Set `read_attempts=1`
when the caller owns retry policy.

`timeout` bounds connect/read/write/pool inactivity and checks elapsed time in the
streamed body loop. Synchronous calls do not promise an absolute wall-clock
deadline: header trickling can continue while making progress, and a blocked
body read can overshoot the elapsed check by one read timeout. Synchronous hard
workflow cancellation is caller-owned. Async calls additionally enforce one
`asyncio.wait_for` deadline across connection, headers, body and retries; caller
cancellation propagates and closes the owned response. This is not a process-kill
deadline. Async callers can also bound an entire multi-call workflow. Responses are streamed under explicit byte bounds; compression is not
requested or accepted, and redirects are refused. Structured `PonderError`
exposes only a safe code/status/outcome_unknown flag, never raw remote messages,
request bodies, transport URLs or credentials.

## API and authoring boundary

`client.training`, `models`, `learning`, `post_training`, `evaluation_runs`,
`datasets` and `dataset_preparations` cover the shared operation matrix bundled in
`operation-matrix.json`. Public `inputs` and `models` are generated TypedDict and
union types, including nested fields, from the TypeScript Zod wire schemas.
Runtime JSON Schema validation preserves the same default/standard string
normalization metadata. Additional immutable-reference, request/hash, revision,
workspace and cursor checks protect the client boundary; server domain admission
and authorization remain authoritative. Compact training-envelope hashes are independently recomputed. Harness/Learning
resource seals use a different existing pretty-JSON/localeCompare algorithm;
Python preserves their authenticated declarations and pinned references without
claiming independent recomputation or ICU portability. This affects Harness
source/agent/release, Learning resources, dataset workspace, post-training plan
and evaluation-manifest seals. Raw Harness file SHA256/size/complete asset closure
and private-policy visibility are independently checked. Existing sealed resources
can be submitted/read, while their domain admission remains server-owned. Python
custom Harness/Reward authoring and a universal Harness hashing bridge are not
part of this package. Portable resource formats are accepted;
this SDK does not execute Python-authored custom Rewards or environments.

Learning methods accept the existing typed command/read envelopes, including
explicit workspace `scope`, not a second workflow language. Generic `command`
provides the current evidence/feedback/review/batch/policy/iteration controls.
`submit_example` and `submit_feedback` wrap the existing typed submissions.
See `examples/continual.py` for native API orchestration. Learning resource pages
retain `nextCursor`; callers pass it as `afterId` in the next read. Training job
pages use `cursor`, preparations use `afterId`, and evaluation pages use their
numeric consecutive offset cursor. Never restart pagination from the beginning
after a failed mutation. All page APIs expose the full retained cursor.

The existing estimate client contract has no current hosted route and is not a
prerequisite for preparation/start. Known unavailable routes raise
`unsupported_hosted_operation` before dispatch; the matrix records local/hosted
availability. Fresh GPU catalog and explicit approved spend remain subject to
server admission.

Current executable training is discovered through capabilities: GRPO and
reward-model jobs in the deployed host's supported model/runtime envelope.
Recipe schema enums do not establish SFT/DPO/PPO or gradient/session support.
Candidate decisions do not activate serving. Training start, funding, evaluation
start/retry, acceptance and serving are separate explicit controls. Ordinary
hosted `prepare_run` compiles an existing reviewed batch on the server; Python
never shells out to a Node authoring compiler. Advanced `stage_artifact` and
`create_job` require already-authored portable artifacts, immutable hashes,
capabilities and exact approval. Dataset source ingestion/large uploads remain
subject to the existing public format and API limits.

## Development and release

```sh
uv sync --project python/openpond-sdk --locked
pnpm exec tsx python/openpond-sdk/tools/export-wire.ts
uv run --project python/openpond-sdk python python/openpond-sdk/tools/generate_models.py
uv run --project python/openpond-sdk python python/openpond-sdk/tools/generate_models.py --inputs
uv run --project python/openpond-sdk python python/openpond-sdk/tools/generate_clients.py
uv run --project python/openpond-sdk pytest python/openpond-sdk/tests
uv build --project python/openpond-sdk --no-sources
```

The schema asset uses versioned, lossless structural interning. One bounded
strict decoder expands it before validation or type generation; JSON Schema
local references, parsing policies and annotations retain their original scope.
The shared and packaged asset bytes match.

The command is a development schema exporter only; installed consumers never
need it. Shared canonical fixtures include omitted/null, Unicode, integer-key
ordering and JavaScript number boundaries. The canonical JSON implementation
matches the existing protocol, including JS array-index enumeration; plain JCS
object sorting alone would give different hashes. Python integers must be exactly
representable as a JavaScript binary64 value rather than silently rounded.

`tools/prepare_release.py` builds source/wheel distributions and records exact
hashes without publishing. `tools/check_consumer.py` verifies the exact wheel in
isolated temporary pip and uv environments. The manual
`.github/workflows/release-python-sdk.yml` workflow first builds, validates and
uploads immutable candidate artifacts after successful CI on that source commit.
It never publishes from the build lane. After reviewing that run's manifest,
source bindings, wheel, source distribution and consumer receipt, publish the
same artifacts with their exact source/run/version/manifest binding:

```sh
# Run from the reviewed source ref; these are operator commands, not yet run.
gh workflow run release-python-sdk.yml --ref REVIEWED_REF -f mode=build -f version=0.1.0
gh run download REVIEWED_BUILD_RUN -n ponder-python-candidate -D reviewed-python-candidate
sha256sum reviewed-python-candidate/manifest.json
gh workflow run release-python-sdk.yml --ref REVIEWED_REF -f mode=publish -f version=0.1.0 -f candidate_run_id=REVIEWED_BUILD_RUN -f candidate_sha=REVIEWED_40_CHARACTER_COMMIT -f manifest_sha256=REVIEWED_MANIFEST_SHA256
```

The publish lane requires the protected `pypi-production` environment and
`PONDER_SDK_PYPI_OWNER_VERIFIED=true`, set only after independent project ownership
and exact repository/workflow/environment trusted-publisher bootstrap. No token
or first-publication authority is inferred from the package name or build. It
downloads the reviewed build without rebuilding, checks all artifact digests,
reconciles any already-published exact version and uses the pinned official PyPI
OIDC action. A mismatching existing release refuses; an ambiguous upload requires
read-only reconciliation of those same digests before retrying. A wheel hash is
not publisher ownership. Actual hosted qualification
requires retained API receipts and separately authorized compute; local consumer
checks do not claim GPU execution, wrong-team deployed denial or live serving.
