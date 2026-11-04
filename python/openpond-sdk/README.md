# Ponder Python SDK

Native synchronous and asynchronous access to existing OpenPond training,
evaluation, dataset and continual-learning APIs. Python3.10+; no Node subprocess,
Desktop application, or uv installation is required to use the installed wheel.
Distribution `ponder-sdk`, import `ponder_sdk`, candidate version0.1.2. Name and
publisher ownership must be verified before publication; this source is not a
claim that a registry release exists.

```sh
pip install ponder-sdk==0.1.2
# or: uv add ponder-sdk==0.1.2
```

Use an existing workspace API credential and explicit API origin. Do not put
credentials in source or request URLs. The SDK does not perform a second login.
For the official CLI use the running app's configured OpenPond home as described
in the repository configuration guide; the SDK accepts the credential explicitly.

```python
from ponder_sdk import Client, inputs

with Client(base_url=api_base_url, api_key=api_key,
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

Estimate availability and measured coverage depend on the configured host.
`training.estimate()` uses native HTTP in both clients and checks exact source,
request, GPU, review identity and expiry. Missing timing or resource evidence is
returned as unknown; hourly rates are not expected totals. Pass a preparation's
returned `review` to `start_preparation` to bind that review. It neither reserves
credit/capacity nor grants permission to spend above the approved ceiling.
A `gpu_allocation` component may price conserved, weighted billable allocation
time from matching completed runs at the current whole-Pod rate. GPU count and
other GPU phases must not be charged a second time. Both clients reject an
inconsistent aggregate. Numeric component evidence does not turn unknown
whole-run totals into zero or a complete estimate.

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

## Ponder Fix-it and SFT

Bind the tool-learning client to an explicit project. It shares the parent
client's connection pool and exposes all fourteen existing tool-learning API
operations in both synchronous and asynchronous form:

```python
from ponder_sdk import Client, inputs

with Client(base_url=api_url, api_key=api_key, team_id=team_id) as client:
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
approve training data, spend, or a learned adapter. `register`, `set_state`,
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
admission; schema validation is not authority to capture, bill or train.

For SFT, select `sft` and the supervised recipe on the hosted Model, review the
supervised batch, and use `training.prepare_run` / `start_preparation` with that
pinned Model configuration and bounded spend. The manual example reads the
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
gh workflow run release-python-sdk.yml --ref REVIEWED_REF -f mode=build -f version=0.1.2
gh run download REVIEWED_BUILD_RUN -n ponder-python-candidate -D reviewed-python-candidate
sha256sum reviewed-python-candidate/manifest.json
gh workflow run release-python-sdk.yml --ref REVIEWED_REF -f mode=publish -f version=0.1.2 -f candidate_run_id=REVIEWED_BUILD_RUN -f candidate_sha=REVIEWED_40_CHARACTER_COMMIT -f manifest_sha256=REVIEWED_MANIFEST_SHA256
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

### Optional local activation reference

Both native clients can retain steering and inspection configurations through
the existing `training.save_experiment_draft`, `get_experiment_draft`,
`list_experiment_drafts` and `archive_experiment_draft` operations on compatible
hosts. Use `operationType: "neuron_steering"` or `"inspect_activations"` and an
`activationForm` from the generated inputs. Blank numeric values remain strings;
prompt/coordinate row IDs must be unique. Saving does not publish a profile,
prepare execution or create compute. Hosted execution remains unavailable.

Use `training.modification_capabilities(input)` in sync/async clients for a
read-only model/runtime observation. Pass `teamId`, `modelId`, `source`, and
known exact revision/tokenizer/template/asset fields using
`ModelModificationCapabilitiesQuery`. The response is bound to that query and
workspace, includes the current actor and expires within five minutes. The
current host projection returns unsupported-model or unqualified-runtime
reasons; no activation executor is advertised. Format support (`draftSchema`)
is separate from permission. This read creates no Job, reservation or capacity.
When the current actor is known, the lightweight
`modification_identity.verify_modification_capabilities` helper additionally
checks it with `expected_actor_id`.

The generated models include hashed neuron-steering profiles, residual
calibrations and bounded activation-reference requests/results. Lightweight
verification helpers live in `ponder_sdk.neuron_steering`; importing the HTTP
SDK does not import PyTorch or require it as a dependency.

With PyTorch installed separately for your hardware, run the synthetic CPU
example from the source distribution:

```sh
python examples/activation_reference.py --output reference-result.json
```

The example uses a tiny deterministic network, two tokenized prompts and Off,
zero, signed-dose and token-scope variants. It is a numerical example, not a
pretrained model benchmark. `ActivationReferenceExecutor` in
The example now starts with saved text authoring and uses
`ponder_sdk.activation_forms.compile_activation_form`. Supply the form, exact
`NeuronSteeringModel` and an `ActivationFormTokenizer` carrying the matching base
source, tokenizer descriptor and unpadded encoder. The compiler verifies those
identities, rejects incomplete required numeric controls and creates the explicit
baseline/sweep request. Inspection ignores inactive steering controls. Fixed
calibration artifacts must be supplied both here and to the executor. The adapter
is trusted local custody, not hosted tokenizer attestation; this compiler imports
no PyTorch and starts no remote work.

`ponder_sdk.reference.activations` accepts a trusted `DenseReferenceModel`
adapter around an already loaded model. The executor downloads no weights and
does not call the hosted API. Only serial, single-device, unquantized dense
execution without adapters is implemented.

Profiles use zero-based additive `down_proj` input interventions and FP32
midpoint residual medians. Prompt-based normalization costs an additional
unsteered prefill; fixed mode pins a calibration artifact. Captures and full
context recomputation are bounded explicitly, including inspection of the last
generated token. The host must route all access through the exclusive reference
executor. Its lock is not a production batching or cache-isolation solution.

The optional manual numerical workflow is deliberately separate from ordinary
HTTP SDK tests:

```sh
python -m pytest reference-tests/test_dense_activation_workflow.py
```

Hosted neuron execution, immutable profile publication, CLI execution and managed
serving are not provided by this reference. Draft UI/API authoring is separate.
Original neuron coordinates cannot
be carried to a different checkpoint without a new experiment.


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
example in the shared UI uses this same local storage and never creates a Job,
credit reservation or served model. HTTP helpers remain independent of Torch.

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
Current capability discovery advertises no qualified managed activation runtime,
so these interfaces do not imply that an arbitrary checkpoint can execute.

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
operation ID, plan hash, revision and approved spend cap. Capability reads,
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

### Standalone downloaded modification inference

The optional `ponder_sdk.reference` loaders consume local exported files without
an OpenPond account, worker or hosted endpoint. Install `ponder-sdk[inference]`
in a separate Python 3.12 inference environment. The extra pins the Decision release's
Torch/Transformers/PEFT dependency versions and the tested safetensors reader;
it does not add these dependencies to the ordinary HTTP SDK. Choose the Torch
wheel for your device separately when needed (a compatible CPU wheel also
satisfies the pinned Torch version). No loader downloads weights or executes
Python code from a model directory.

`reference.qwen3.load_qwen3_snapshot` loads the local, unquantized BF16
`Qwen/Qwen3-8B` snapshot at revision
`b968826d9c46dd6066d109eabc6255188de91218`. Supply the exported exact model
identity and tokenizer descriptor; file hashes, configuration, complete live
weight hash, architecture and projection geometry are checked before use.
Quantized, fused, sharded, adapted or different bases are refused. A caller can
also construct a `Qwen3Snapshot` around an already loaded exact model and its
source descriptors. Loaders verify it again and require exclusive ownership.
`snapshot.steering_reference()` adapts that exact base to the existing
`ActivationReferenceExecutor` for downloaded steering profiles and inspection;
it retains the executor's serial, full-context, no-KV semantics.

```python
from ponder_sdk.reference.qwen3 import load_qwen3_snapshot
from ponder_sdk.reference.engram import load_engram, RequestHistory

snapshot = load_qwen3_snapshot(
    "base-snapshot", model_identity=manifest["pins"]["baseModel"],
    tokenizer_descriptor=tokenizer_descriptor, device="cuda:0",
)
memory = load_engram(snapshot, "downloaded-engram", expected_content_hash=export_hash)
history = RequestHistory("local-generation", vocab_size=tokenizer_descriptor["vocabSize"])
try:
    # input_ids is a [1, tokens] LongTensor on the snapshot's device.
    output = memory(input_ids, history=history, enabled=True, use_cache=True)
    # For the next decode call, pass only the new token and this exact KV object.
    # output = memory(next_token_ids, history=history,
    #                 past_key_values=output.past_key_values, use_cache=True)
finally:
    history.release()
    memory.detach()
```

Engram requires exactly `openpond_qwen_engram_paper_v1`, per-hash dimension 256,
attention-input hooks at layers 1/3/7/15, and the two exported files
`manifest.json` and `adapter.safetensors`. The loaded state includes shared
embeddings, occupancy flags, projections and gates. Inference never changes
occupancy or initializes new learned weights. This is separate from Spark or
DeepSeek memory formats. A history owns one generation, module, On/Off choice
and KV object; use a new history for each generation or toggle comparison.
A failed forward closes its history, and callers from a different thread or
asyncio task are refused even when the thread is shared. Keep manual
`memory.request(...)` and `patch.request(...)` scopes synchronous: do not await
inside them. The context managers do not change thread-local Torch inference
mode across their yields; the synchronous numerical calls manage it locally.
Uncached calls must supply the complete prefix. Direct access to the attached
base must run inside `memory.request(...)`; ordinary `model.generate()` is not
an implicit request/history adapter.

`reference.neuron.load_neuron_patch(snapshot, directory,
expected_content_hash=...)` verifies the two-file selected-neuron export and
attaches its F32 column deltas without merging or rounding them into the base.
Use `with patch.request(enabled=True): output = snapshot.model(...)`; Off is an
explicit `enabled=False` request, and `patch.detach()` removes every hook.
An optional original `request=` additionally verifies training provenance.
The sealed coordinate/delta artifact is sufficient for inference loading.

`reference.alphaedit.load_alphaedit(snapshot, directory,
expected_content_hash=...)` checks the manifest, `patch.safetensors` and all
`state-N.safetensors` files. AlphaEdit's patch contains **exact replacement BF16
matrices**, not additive deltas. Installation requires a fresh exact base,
validates all tensors first, stages device copies, and restores original weights
if installation fails. A native device failure that also prevents rollback
marks the snapshot unusable; discard that snapshot/model. Inference uses the
replacement weights directly; covariance/projector/cache state is verified in
bounded slices without running editing or optimization. A second installation
against the already edited base is refused.

`reference.decision.load_decision(directory, expected_content_hash=...,
artifact_id=..., model_identity=..., source_directories=..., device="cuda:0")`
loads the four-file PEFT export (`manifest.json`, `adapter_model.safetensors`,
`adapter_config.json`, `decision_contract.json`). Its six local source directories
are keyed `backbone`, `originalAdapter`, `tokenizer`, `reference`,
`backboneLicense` and `releaseLicense`; each must match its complete source
manifest. The supported backbone is the full pinned Qwen3.5-9B conditional
model, with the exact documented auxiliary-MTP omission, not a generic causal
LoRA target. The bundled Apache-2.0 prompt code is byte-pinned and attributed.
`scorer.score(request)` accepts the existing `DecisionScoringRequest`, bound to
that exported artifact ID/hash, and returns a verified `DecisionScoringResult`.
It computes every declared candidate's next-token logit and T1 probability,
including integer expected levels; it does not grade generated JSON or text.

The local scorer's runtime hash describes its actual package/source versions,
not a hosted worker attestation. Limits/cancellation are cooperative between
native calls. CPU file, projection, history and installed-package checks cover
these boundaries; exact-model trained-result reload/forward and model-quality
acceptance still require separate native evidence. No such acceptance is implied
by installing the extra or passing the reference workflow.
