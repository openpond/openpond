# Ponder Python SDK

Native synchronous and asynchronous access to existing OpenPond training,
evaluation, dataset and continual-learning APIs. Python3.10+; no Node subprocess,
Desktop application, or uv installation is required to use the installed wheel.
Distribution `ponder-sdk`, import `ponder_sdk`. The examples below use the 0.1.6 API.

```sh
python -m pip install "ponder-sdk>=0.1.6"
```

Use an existing workspace API key. The SDK connects to OpenPond automatically. Do not put
credentials in source or request URLs. The SDK does not perform a second login.
For the official CLI use the running app's configured OpenPond home as described
in the repository configuration guide; the SDK accepts the credential explicitly.

```python
from ponder_sdk import Client, inputs

with Client(api_key=api_key,
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
workflow cancellation is caller-owned. Resource API async calls additionally enforce one
`asyncio.wait_for` deadline across connection, headers, body and retries; caller
cancellation propagates and closes the owned response. This is not a process-kill
deadline. Async callers can also bound an entire multi-call workflow. Responses are streamed under explicit byte bounds; compression is not
requested or accepted, and redirects are refused. Structured `PonderError`
exposes only a safe code/status/outcome_unknown flag, never raw remote messages,
request bodies, transport URLs or credentials.

## Add production tasks

Use a Dataset ID from your workspace. A successful receipt confirms durable task/processing storage; the Tasks view may
lag acknowledgement. It does not authorize training or create a Model.

```python
from ponder_sdk import Client

with Client(api_key=api_key, team_id=team_id,
            dataset_id=dataset_id) as client:
    receipt = client.add_task({
        "id": event_id,
        "name": "Expired token",
        "input": {"prompt": "Refresh the token and retry the request"},
        "source": {"kind": "production", "eventId": event_id},
    })
```

`AsyncClient.add_task` has the same arguments and is awaited. Retain a stable
idempotency key for each source event and reuse it for uncertain delivery; writes
are never automatically retried. A repeated key with changed content is rejected.
For flat task calls, `PonderError.operation_id` also retains the generated key
when the server response or transport fails. Async cancellation requires retaining
your own explicit key before starting the call. Each request is limited to128KiB.

Optional standard OpenTelemetry span exporters are described in
[Optional OpenTelemetry](#optional-opentelemetry-adapter). They require an explicit task projection;
`add_task` accepts structured OpenPond tasks, not OTLP payloads or arbitrary logs.

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

### Hosted dataset source uploads

Use `client.dataset_imports` with a configured API origin that supports resumable
dataset uploads. For example, with an existing authenticated `client`:

```python
from pathlib import Path

path = Path("examples.jsonl")
receipt = client.dataset_imports.begin(
    operation_id="examples-upload-1",
    files=[{"relativePath": path.name, "sizeBytes": path.stat().st_size}],
)
import_id = receipt["importId"]
file_id = receipt["files"][0]["fileId"]
queued = client.dataset_imports.upload_file(
    import_id, file_id, path, operation_id="examples-upload-1:complete"
)
preview = client.dataset_imports.preview(import_id, file_id, limit=10)
```

Reuse the original operation IDs and exact file bytes to resume. The upload
helper hashes and sends the file in bounded chunks. Use `get` for verification
status and `preview` for the source sample and accepted/rejected counts. Pass the
returned `revision` and `nextCursor` as `revision` and `after` to page forward.
Use `storage` to read available capacity or `cancel` with its own stable operation
ID to request cleanup. All methods are also available on `AsyncClient`.

### Learning and training

Learning methods accept the existing typed command/read envelopes, including
explicit workspace `scope`, not a second workflow language. Generic `command`
provides the current evidence/feedback/review/batch/policy/iteration controls.
`submit_example` and `submit_feedback` wrap the existing typed submissions.
See `examples/continual.py` for native API orchestration. Learning resource pages
retain `nextCursor`; callers pass it as `afterId` in the next read. Training job
pages use `cursor`, preparations use `afterId`, and evaluation pages use their
numeric consecutive offset cursor. Never restart pagination from the beginning
after a failed mutation. All page APIs expose the full retained cursor.

Estimate availability and measured coverage depend on the configured host.
`training.estimate()` uses native HTTP in both clients and checks exact source,
request, GPU, review identity and expiry. Missing timing or resource evidence is
returned as unknown. Pass a preparation's returned `review` to
`start_preparation` to bind that review. Numeric component evidence does not
turn unknown whole-run totals into zero or a complete estimate.

Current executable training is discovered through capabilities: GRPO and
reward-model jobs in the deployed host's supported model/runtime envelope.
Recipe schema enums do not establish SFT/DPO/PPO or gradient/session support.
Candidate decisions do not activate serving. Training start, evaluation
start/retry, acceptance and serving are separate explicit controls. Ordinary
hosted `prepare_run` compiles an existing reviewed batch on the server; Python
never shells out to a Node authoring compiler. Advanced `stage_artifact` and
`create_job` require already-authored portable artifacts, immutable hashes,
capabilities and exact approval. Dataset source ingestion/large uploads remain
subject to the existing public format and API limits.

## Ponder Fix-it and SFT

Bind the tool-learning client to an explicit project. It shares the parent
client's connection pool and exposes all fourteen existing tool-learning API
operations in both synchronous and asynchronous form:

```python
from ponder_sdk import Client, inputs

with Client(api_key=api_key, team_id=team_id) as client:
    tools = client.tool_learning(project_id=project_id)
    page = tools.installations()
    # Keep page["nextCursor"]; pass query={"after": cursor} for another page.
    installation = tools.installation(installation_id)
    episodes = tools.episodes(installation_id)
    episode = tools.episode(installation_id, episode_id)
    manifest = tools.manifest(installation_id)

    # request is an already-sealed, reviewed ToolLearningConsultationRequest
    # from your capture/consultation integration. This may incur model usage.
    # response = tools.consult(request)
    # If a submit reply is lost, reconcile the SAME request without replay:
    # response = tools.consultation(request)
```

Owner credentials register/control installations, select routing, project
recoveries, and purge retained events. Use the separate short-lived installation
credential for capture/manifest/consultation calls; possession of it does not
approve training data or a learned adapter. `register`, `set_state`,
`append`, `project`, `purge`, `configure_routing`, and `consult` are explicit
mutations and are never automatically replayed. Queries cannot override the
bound project. Response scope, installation, operation, echoed configuration,
event references and consultation/model identity are checked before return.

Tool-learning and Harness seals use the existing Harness canonical format,
which differs from the compact training protocol. Retain seals from the
qualified integration/host owner; **do not use `canonical_sha256` to create
Harness event, action, context, manifest or routing seals.** Like portable
Harness packages, these are host-authenticated declarations rather than a
claim that this Python client reproduces JavaScript locale collation. Installed
Python makes no Node subprocess calls. The canonical host validates seals and
admission; schema validation is not authority to capture or train.

For SFT, select `sft` and the supervised recipe on the hosted Model, review the
supervised batch, and use `training.prepare_run` / `start_preparation` with that
pinned Model configuration. The manual example reads the
actual selected method and checks hosted capabilities, revision and etag; it no
longer assumes every preparation is GRPO. Status, outputs and cancellation use
the same existing operations. A completed optimizer run does not automatically
activate an adapter or establish better held-out behavior.

## Development and release

```sh
pnpm run python:sdk:generate
uv sync --project python/openpond-sdk --locked
pnpm exec tsx python/openpond-sdk/tools/export-wire.ts
pnpm exec tsx python/openpond-sdk/tools/tool-learning-fixtures.ts
pnpm run python:sdk:generate
uv run --project python/openpond-sdk python python/openpond-sdk/tools/generate_clients.py
uv run --project python/openpond-sdk pytest python/openpond-sdk/tests
uv build --project python/openpond-sdk --no-sources
```



The request and response type directories (`inputs/` and `models/`) are generated
from the packaged `schemas.json` authority and stay out of Git. Run
`pnpm run python:sdk:generate` before source development; `pnpm run test:python:sdk`
does this automatically. Isolated wheel, source-distribution and editable builds
also regenerate both directories with Python only and include their `.py` files.
The schema authority, operation inventory and generated HTTP client modules remain
versioned. Installed wheels need neither Node nor a generator.

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
gh workflow run release-python-sdk.yml --ref REVIEWED_REF -f mode=build -f version=REVIEWED_VERSION
gh run download REVIEWED_BUILD_RUN -n ponder-python-candidate -D reviewed-python-candidate
sha256sum reviewed-python-candidate/manifest.json
gh workflow run release-python-sdk.yml --ref REVIEWED_REF -f mode=publish -f version=REVIEWED_VERSION -f candidate_run_id=REVIEWED_BUILD_RUN -f candidate_sha=REVIEWED_40_CHARACTER_COMMIT -f manifest_sha256=REVIEWED_MANIFEST_SHA256
```

The publish lane requires the `pypi-production` environment and
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

`training.result(job_id)` reads exact retained training results in both native
clients. It verifies workspace/Job identity, original source references, output
inventory, checkpoint and cleanup evidence. Original settings are returned
separately from the compiled runtime recipe hash. This operation is implemented
in source and requires a compatible hosted release; saving a named Model and
activating serving remain separate operations.

`training.save_result_model(job_id, request)` saves the reviewed candidate with
one stable operation ID and expected Model revision. The name applies to its
producing Model, and the receipt retains the exact checkpoint and original
settings independently of later configuration edits. Use
`training.saved_model(model_project_id, {"teamId": team_id})` to read the most
recently explicitly saved version. Both methods support sync/async clients;
uncertain writes require explicit retry of the original request. Saving remains
separate from serving activation. Source support does not establish deployed
save/concurrency or artifact/serving lifecycle qualification.


Saved-Model serving reads use `training.model_serving(model_project_id,
{"teamId": team_id, "versionHash": version_hash})` in both native clients.
Use the exact saved-version hash from `training.saved_model`. The clients
verify the saved snapshot, publication and deployment/pool/load references.
Active routing and historical inference evidence do not prove a currently warm
worker or released provider capacity. This source API still requires hosted
qualification; this read never activates or stops serving.


`training.control_model_serving(model_project_id, request)` explicitly activates
or stops an exact saved version in both clients. Use the typed request from
`openpond.trainingModelServingControlRequest.v1`: workspace, original operation
ID, saved-version hash, registry artifact reference, expected control revision,
action and idle timeout. Read status before a new command. Retain the same body
and operation ID after an uncertain reply; no write is automatically retried.
The returned receipt acknowledges admission; status observes readiness and
cleanup. Stop removes routing before capacity retirement and preserves shared
consumers and unsettled calls. Runtime/lifecycle qualification is still pending.

### Retain local external observations

Use the ordinary `Client` or `AsyncClient` configured for the authenticated
loopback app server, with the same workspace and local capability. These
endpoints are local and do not create hosted execution or cloud custody:

```python
recording = client.training.record_modification_observation(command)
retained = client.training.modification_recording(recording["id"], {"teamId": team_id})
page = client.training.modification_recordings({"teamId": team_id, "limit": 30})
```

`command` uses `inputs.ModificationRecordingRequest`: schema version
`openpond.modificationRecordingRequest.v1`, `teamId`, retained `operationId`,
`name`, nullable `projectId`, `method` (`neuron_steering` or
`inspect_activations`), and exact activation-reference `request`/`result`.
The canonical command is limited to 8 MiB. Reuse the unchanged command after an
uncertain reply. Metadata, model/result/artifact identity and capture coverage
are verified; list cursors retain their account/Project/search scope.

`custody: local`, `provenance: external_observation` and
`measurementAttestation: unattested` remain explicit. Hashes do not attest the
supplied runtime's measurements or establish a grade. Account/API-origin
switches cannot read the previous account's observations. Importing the CPU
example in the shared UI uses this same local storage and never creates a Job
or served model. HTTP helpers remain independent of Torch.

## Model workflows and adapters

The model-building workflows are SFT, RL and Decision Model. SFT
can train LoRA, Engram memory or selected-neuron patches through their separate
operation families; current RL and Decision training use LoRA. The
workflow/adapter distinction does not add new API operations or make these methods interchangeable on every base.
See the [workflow and continuation matrix](../../docs/public/model-modifications.md).

Neuron steering is a separate inference intervention, documented here for its
existing profiles and interfaces. It does not train weights. Activation
inspection produces observations and can inform neuron selection.

## Managed activation lifecycle

Compatible hosts expose `training.compile_modification_execution(request)`,
`prepare_modification_execution(request)`, `start_modification_execution(request)`
and `cancel_modification_execution(request)` in both sync and async clients.
Use the generated `inputs.ManagedModificationCompile`,
`ManagedModificationPrepare`, `ManagedModificationStart` and
`ManagedModificationCancel` types for exact fields. Compilation uses registered
tokenizer custody; preparation retains inputs and cap without starting a GPU.
Start requires explicit approval of the retained execution ID, revision, plan
hash and cap. Retry an uncertain command with its unchanged operation ID.

`list_modification_executions(query)` returns creator-scoped metadata history;
`get_modification_execution(execution_id)` reads its verified request and any
retained capture. A capture does not establish cleanup or final settlement.
Read current capability discovery for the exact model/runtime; these interfaces
do not establish that an arbitrary checkpoint can execute.

Preparations may include `sourceForm` to retain the exact text and controls.
Fresh preparation recompiles that form against the host's exact tokenizer;
copying a retained form still requires a new operation and approval.

`ponder_sdk.activation_comparison.verify_and_compare_activation_reference_result`
compares two variants from one verified request/result. Capture differences
require matching causal token prefixes; missing or diverged evidence remains
explicit. The helper does not assign quality grades or import Torch.

Hosts implementing steering publication also expose
`save_modification_result_model`, `get_steering_profile`,
`list_steering_profiles`, `archive_steering_profile` and `model_version`.
Save pins one non-baseline variant from a completed managed result to a named
Model. The returned steering version retains exact profile/base/source evidence;
it grants no serving capability or allocation. Reconcile a save or archive with
the same operation ID and original request.

### Engram execution and saved Models

The configured `client.training` and async equivalent expose
`engram_execution_capability`, `compile_engram_execution`,
`prepare_engram_execution`, `start_engram_execution`, `get_engram_execution`,
`list_engram_executions`, `cancel_engram_execution`, and
`save_engram_result_model`. Use the generated input types and original workspace,
operation ID, plan hash and revision. Capability reads,
compilation, preparation and saving do not start paid training or serving.
An unavailable capability remains unavailable until the exact runtime is qualified.

`training.saved_model_serving(model_project_id, {"teamId": team_id, "versionHash": version_hash})`
reads the exact saved version's typed serving state, including Engram modules.
`training.control_engram_model_serving(model_project_id, request)` sends the
distinct `openpond.engramModelServingControlRequest.v1` command: original
operation ID, team, version hash, expected revision, `activate`/`stop`,
`defaultEnabled` and idle timeout (60–3600 seconds). Use the same command to
reconcile an unknown acknowledgement; writes are never automatically replayed.
The client verifies the exact Model/module, sealed receipt, binding, capacity,
cleanup and retained runtime evidence. An accepted Stop does not itself prove
capacity was released, and a saved module does not qualify a runtime. The
`ponder_sdk.engram_serving_identity` helpers also verify resolved per-request
selection and completed inference receipts against their admitted identities.

The portable helpers in `ponder_sdk.engram_identity` verify saved Engram versions,
create an exact compact starting Model pin, and seed a continuation form with
`engram_form_from_model_version`. The form retains `startingModule` plus the exact
parent artifact; it does not substitute the base Model or resume optimizer/RNG
state. The two-file learned module is separate from LoRA and activation profiles.
Tensor custody, reload behavior and model quality require their own runtime evidence.

## Optional OpenTelemetry adapter

Install `pip install 'ponder-sdk[opentelemetry]'` to use the standard
[Python SpanExporter interface](https://opentelemetry-python.readthedocs.io/en/latest/sdk/trace.export.html).
The base SDK has no OpenTelemetry dependency. Configure the exporter in your
existing OTel provider, or create an explicitly owned provider:

```python
from ponder_sdk import Client
from ponder_sdk.opentelemetry import OpenPondSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def project_span(span):
    attributes = span.attributes or {}
    # Application-owned selection and redaction, not automatic prompt capture.
    if attributes.get("app.learning_task") is not True:
        return None
    prompt = attributes.get("app.sanitized_task_input")
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    return {"name": span.name, "input": {"prompt": prompt}, "split": "validation"}


with Client(api_key=api_key, team_id=team_id,
            timeout=5) as client:
    exporter = OpenPondSpanExporter(client=client, dataset_id=dataset_id,
                                   project_span=project_span,
                                   max_export_batch_size=32)
    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(
        exporter, max_export_batch_size=32, max_queue_size=256,
        export_timeout_millis=30000))
    try:
        tracer = provider.get_tracer("production-agent")
        # Supply tracer to your agent or use existing framework instrumentation.
    finally:
        provider.shutdown()  # Drain before closing the shared OpenPond client.
    if exporter.last_export_error is not None:
        # Report through your application's diagnostics, without raw task content.
        report_telemetry_failure(exporter.last_export_error)
```

The required projection selects completed useful runs and redacts any sensitive
content. Only the returned structured task plus trace/span source IDs are sent to
`add_task`; attributes, prompts, events and outputs are never copied implicitly.
Span events can carry logs/exceptions for an explicit projection. This does not
install instrumentation, change the global provider, accept OTLP, or export
standalone logs or metrics. The OTel processor owns background buffering; the
synchronous `Client` is intentional because Python's exporter API is synchronous,
even in an otherwise asynchronous application.

Each trace/span pair gets a stable dataset-scoped idempotency key. Keep projections
deterministic so replaying after a lost reply cannot create a duplicate task or
conflict with an altered payload. Oversized/concurrent batches fail; per-task
HTTP/validation errors return `SpanExportResult.FAILURE` and expose bounded
`last_export_error.failures` with trace/span IDs. A 25s batch budget prevents new
submissions after its deadline; an already running synchronous HTTP call uses the
client's finite timeout and cannot be cancelled by the exporter. Use small batches
and a short client timeout. No retry thread or durable outbox is created. OTel
queues can drop full/failed batches; use direct `add_task` with an application
outbox when delivery must be durable. Upload does not authorize training.

Flush the provider to drain its queue; exporter `force_flush(timeout_millis)` only
waits for its active export. Flush success does not prove every write succeeded;
inspect `last_export_error` and OTel diagnostics. Exporter shutdown rejects new
batches and waits up to 30s for active work. If it times out, keep the client open
until work completes. It never closes the application-owned client.

## Named product models

Configure your `api_key`, workspace `team_id`, and
`model_aliases={"support": model_id}` on either client. Use a key authorized for
the selected Dataset and Model; a Dataset-only upload key cannot invoke inference. Then use
`client.models.support.generate(prompt="...")` (await it on AsyncClient), or
iterate `client.models.support.stream(prompt="...")` (async iteration on AsyncClient).
These typed text calls use the existing owned pool and OpenPond's personalized
serving API. They never choose a catalogue default, activate serving,
capture tasks automatically or replay paid inference. Existing Model
administration remains available alongside aliases.

Results retain `text`, `request_id`, `model_id`, `resolved_model_id`,
`finish_reason`, nullable `usage`, nullable `system_fingerprint` and nullable retained `evidence`. Stream events
have `type="text"`/`text` or `type="finish"`/`result`; incomplete streams raise.
Use `contextlib.closing`/`aclosing` for early iterator exit. Keep this client in
your product backend; React calls your authenticated application routes.
There is no SDK capture queue or flush API.

### Recovering queued named Model requests

The signed serving review sets `workerIdleTimeoutSeconds`. Current v3 reviews
support 5 or 60 seconds, with new reviews using a 60-second billable idle reuse
window before unused capacity scales to zero. Activate with the reviewed value;
historical v1/v2 reviews retain their signed 5-second setting.

Named Model `generate` and `stream` accept `client_request_id` and a serving-only
`timeout` of at most 630 seconds (the default). HTTP 202 is observed through the
original request's retained status. No paid POST is retried. If observation ends
with an unknown outcome, retain `ModelRequestError.client_request_id` and call
`client.models.support.recover(client_request_id)`, or `inspect_request(request_id)`
when the canonical ID is known. `cancel_request(request_id)` requests Stop for that
exact operation. Await these methods on `AsyncClient`. Recovery enforces current
access and the Model identity; answers have finite retention.
