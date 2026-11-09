# Workflows and adapters

Adapters change learned parameters or add computation to an open-weight model. A useful workflow keeps the original model, records an exact change, compares the result, and retains a version that can be reproduced.

OpenPond's [training workflow](training.md) connects reviewed examples, model recipes, evaluation and artifacts. Choose a workflow, then a compatible adapter and exact starting model. Compilation, preparation, explicit Start/Cancel and history reuse the existing operation families. Execution and serving availability are checked separately for the selected checkpoint, adapter and runtime.

## Workflows and adapters

| Workflow | Adapter | What learns or changes |
| --- | --- | --- |
| SFT | LoRA | Learns low-rank weight updates from reviewed answers. |
| SFT | Engram adapter | Learns n-gram memory tables, projections and gates over a frozen base. |
| SFT | Neuron training | Learns deltas for selected MLP output-projection columns using target and background examples. |
| RL / GRPO | LoRA | Learns policy updates from rewards over generated response groups. |
| Decision Model | LoRA | Trains the specialized Decision adapter or scores allowed choices with its original or saved weights. |

SFT and RL describe how a model learns. LoRA, Engram and neuron training describe which parameters learn. Decision Model describes a scoring task; its current implementation uses a particular LoRA release and backbone. Adapters is the product category for these saved changes; LoRA weights, Engram memory and neuron patches retain different technical formats.

The ordinary SFT recipe uses LoRA. Supervised Engram and neuron training retain their dedicated requests and executors. The current RL and Decision implementations use LoRA; Engram or neuron-training alternatives for those workflows require further integration. Full-parameter training is not an admitted ordinary SFT recipe. A starting base is a checkpoint choice, not a separate training objective.

### Current support matrix

| Workflow | LoRA | Engram | Neuron training |
| --- | --- | --- | --- |
| SFT | Implemented | Implemented | Implemented |
| RL | Implemented | Not supported yet | Not supported yet |
| Decision Model | Implemented | Not supported yet | Not supported yet |

Implemented means an execution contract and dedicated implementation exist. Exact model/runtime availability and qualification are checked separately. Not supported yet identifies a plausible combination requiring integration; it cannot currently be selected. New model shows these unavailable adapter choices grayed out. This matrix does not imply that different adapters can be stacked or merged together.

The implemented operation families require compatible model and runtime evidence; source implementation does not enable a disabled product workflow. Engram and neuron training currently target the pinned dense BF16 Qwen3-8B; Decision uses its separate Nimble/Qwen3.5 release. Changing the UI workflow does not change the artifact format or make an arbitrary model compatible.

## Weight-space programming

Weight-space programming lets the locally controlled agent inspect remote weights, write a bounded tensor program, evaluate an immutable candidate and save its parameter patch as a Model version. It is direct parameter editing; there is no adapter selector or SFT/GRPO optimizer inside the session. The checkpoint stays remote. Only bounded slices, statistics and development results return to the agent.

The first source implementation targets exact dense BF16 Qwen3-8B, permits bounded reads of named parameters and writes selected MLP down-projection columns. Its Python-syntax input compiles to a limited tensor language, without arbitrary Python, imports or hidden model forwards. The current hosted dispatcher reuses one GPU-backed worker for the whole session: analysis runs on CPU and evaluation on GPU. The numerical library can run on CPU, but hosted Daytona/CPU execution is not implemented.

Availability requires a qualified runtime; these source contracts do not enable paid execution. Preparation starts no compute. Start binds the original plan, price and spending limit; retrying a command retains its operation ID. Saving never activates serving. When a frozen Dataset release is declared, finalization runs the original base and selected candidate on its policy-visible inputs, then closes editing. Existing experiment scoring grades those retained outputs separately; a release reference or generated answer alone is not a quality score. Inspect the installed official CLI's `training --help` and the [weight-space agent reference](../../apps/cli/skills/openpond-cli/references/weight-space-programming.md) for the exact supported operations and limits.

## Inference interventions and inspection

| Operation | What changes | Relationship to training |
| --- | --- | --- |
| Neuron steering | Adds, scales or suppresses selected internal activations during a forward pass. | A saved inference profile; it does not train model weights. |
| Activation inspection | Measures selected activations. | Observation only; it can inform later neuron selection. |

Neuron steering is retained here as an inference-only reference for its existing profiles and interfaces. It is outside the standard new-model training choices. Neuron training produces a learned patch; it does not convert or replace an existing steering profile. Activation inspection remains separate. Each operation still needs a compatible runtime.

## Continuation and continual learning

| Adapter / workflow | New training stage from a saved parent | Continual learning |
| --- | --- | --- |
| SFT + LoRA | Ordinary SFT starts from its pinned base; generic checkpoint continuation is unavailable. | Yes |
| RL + LoRA | Admitted exact-parent Shared, Stacked or Merged modes, with their own compatibility rules. | Yes |
| Engram adapter | Reloads an exact compatible learned module with a fresh optimizer. | No |
| Decision Model | Reloads an exact compatible adapter with a fresh optimizer. | No |
| Neuron training | Saved patches support inference; training continuation/composition is unavailable. | No |

Parent continuation, recovery of an interrupted run and a recurring learning policy are different capabilities. A learned artifact alone supplies no schedule or serving authority. Keeping the base frozen does not guarantee that earlier behavior is preserved; compare independent held-out and unrelated tasks.

The small-model conditional-memory approach has research on Qwen3-4B and Qwen3-8B. It does not require the large DeepSeek model, but it is also not a table of editable text facts. [Engram Adapter](https://arxiv.org/abs/2608.29327). LoReFT is one method in the Representation Finetuning family. [ReFT](https://arxiv.org/abs/2404.03592). Neither paper establishes that an arbitrary OpenPond model or hosted worker supports the method.

## Explore, compare and retain a version

A [native Python example](../../python/openpond-sdk/examples/activation_reference.py)
now runs a synthetic CPU network with bounded activation capture and Off, zero
and signed-dose comparisons. It uses an optional local PyTorch environment,
does not download a pretrained model, and creates no hosted Job or serving
allocation. The [Python SDK guide](../../python/openpond-sdk/README.md#optional-local-activation-reference)
describes its explicit numerical semantics and limitations. This reference does
not establish Qwen support or qualify a managed execution runtime.

Saved text authoring can also be compiled locally in Python. Supply the exact loaded model identity and a trusted `ActivationFormTokenizer` whose source pin and hashed descriptor match that model:

```python
from ponder_sdk.activation_forms import compile_activation_form

request = compile_activation_form(
    saved_form,
    method="neuron_steering",
    model=loaded_model_identity,
    tokenizer=tokenizer_adapter,
)
```

The compiler retains an unsteered baseline and the authored strength sweep, checks coordinates and workload bounds, and rejects blank required numbers. Inspection compiles only the baseline. Fixed residual normalization requires the exact calibration artifact at compilation and execution. The supplied tokenizer association is local custody; compiling a form grants no hosted execution authority. The CPU example above includes a complete text-form/tokenizer setup.

The Experiments page can import that example's `{request, result}` JSON as a
local observation. It appears in the existing experiment table and opens a
viewer for prompt/variant/coordinate selection, generated token comparisons and
before/after activation values. The viewer shows raw token IDs against the
retained tokenizer identity; it does not invent semantic feature names.

Observations stay on the device that imported them, scoped to its active
account, workspace and API origin. They retain externally supplied, ungraded
measurements. Hash and capture-coverage verification establishes integrity, not
that OpenPond ran or attested the measurement. Recording an observation starts
no training, paid compute or serving allocation.

The TypeScript SDK exposes `recordModificationObservation`,
`modificationRecording` and `modificationRecordings` on an authenticated local
training client. Native Python provides the corresponding snake_case methods
in sync and async clients. The official CLI provides `experiments
record-modification`, `modification` and `modifications` with `--local --team`.
Use the configured app home and local server origin. These observation endpoints
are local; they do not add hosted execution or cloud storage.

The shared model setup selects a workflow, adapter and compatible starting model before its required inputs and review. An experiment may instead evaluate a model or inspect activations without producing changed weights. Existing steering evidence can compare fixed prompts and intervention strengths. Training requires suitable examples; graded batch evaluation uses exact Dataset and grader releases. Chat can assist with setup or inspection; it is not a required starting point.

For example, compare an unmodified model with several steering strengths on the same prompts. Keep the checkpoint, input, sampling and evaluation conditions fixed so the intervention is the intended difference. Record answer quality, target behavior and runtime overhead. An ungraded observation remains ungraded.

A learned-memory example instead trains on a reviewed fictional support domain, then compares held-out domain questions and unrelated tasks with the base and a same-data LoRA candidate. Save/reload checks establish that the resulting module includes all required state. This is a proposed example to qualify, not a reported OpenPond result.

Selected candidates can be retained as deliberate model versions once the corresponding operation exists. Each version needs exact base/tokenizer identity, the modification artifact, configuration and evaluation references. Saving a candidate and activating serving are separate operations.

## Method settings

Settings follow the selected method's typed form and exact runtime. Architectural choices are not interchangeable controls: the current Engram runtime owns its fixed memory configuration, while neuron training requires target/background selection.

| Area | Useful settings | When the setting takes effect |
| --- | --- | --- |
| LoRA training | Target modules/layers, rank, alpha, dropout, learning rate and training steps | A new training run; changing these does not rewrite a completed adapter. |
| Neuron/direction steering | Layer or hook point, neuron/direction, signed strength, supported operation, normalization and token scope | A new inference run with that profile. |
| Engram adapter | Learning rate, steps, accumulation, sequence length, seed, duration and checkpoint limits | Supervised memory training under the runtime's fixed architecture; continuation retains the exact parent module. |
| Neuron training | Selection count, target/background criteria, optional explicit coordinates, learning rate and preservation settings | Select and train column deltas; a saved patch does not become a continuation parent. |
| Decision Model | Train: reviewed targets and optimizer limits. Score: structured state, allowed choices and scoring limits | Training updates the specialized adapter; scoring measures the selected original or saved version. |
| Inspection | Selected layers/tokens, top-k results and capture bounds | Measurement and retained output; inspection limits do not themselves modify learned parameters. |

LoRA's reference library exposes module/layer selection and rank/scaling settings. [PEFT configuration](https://huggingface.co/docs/peft/en/package_reference/lora). LoReFT remains outside the current supported workflow choices; its layer/component and position-specific interventions are a different method. [pyreft](https://github.com/stanfordnlp/pyreft). Conditional-memory settings must follow the admitted implementation, not arbitrary combinations inferred from a paper.

A possible later training extension is updating selected token embeddings while freezing the remainder. PEFT provides a Trainable Tokens implementation, but OpenPond has not qualified it. Exact tokenizer identity, embedding resizing and tied output weights need explicit handling; this is distinct from n-gram conditional memory. [Trainable Tokens](https://huggingface.co/docs/peft/en/package_reference/trainable_tokens).

Temperature, top-p, answer length and serving precision are also useful controls. They affect sampling or execution and should be labeled separately from learned weight changes. Changing precision can affect whether a modification is supported.

## Serving compatibility

Parameter count alone does not establish compatibility. An 8B model needs an exact checkpoint and tokenizer, a compatible modification artifact, and a runtime that executes that modification correctly. Different methods are not assumed to compose automatically.

A research candidate, a version compatible with a serving destination, and a version actually being served are different states. Check the serving destination and observed state. An eligible artifact is not proof that an endpoint is ready; stopping routing is not by itself proof that allocated GPU capacity has been released.

The SDK's `modificationCapabilities` read and CLI's
`training hosted-modification-capabilities` query the exact selected base-model
identity on compatible hosts. The response separates draft format support from
execution support and retains its workspace, actor and expiry. Inspect the
returned exact runtime evidence and any unsupported/unqualified reason rather
than inferring readiness from a catalog entry. The shared form retains edits
while checking availability. A fresh capability read is still separate from
execution approval or GPU allocation.

Use the same lifecycle interfaces from the UI or your harness. Training and managed activation operations retain separate typed results. An activation capture is not a deployable Model; saving or serving a modification needs its own compatible artifact and runtime. The installed skill describes supported commands and capability checks; installing instructions adds no worker capability.

For current operations, use the [CLI command reference](../../apps/cli/docs/command-reference.md) and the installed command help. Workflow labels do not rename commands or combine separate operation families.

## Inspect a managed modification execution

On a host implementing managed execution inspection, read an existing execution with:

```ts
const execution = await training.getModificationExecution(teamId, executionId);
```

The matching native Python method is `client.training.get_modification_execution(execution_id)` in sync and async clients. The official CLI provides:

```sh
openpond training hosted-modification-execution <execution-id> --team-id <id> --json
```

This read returns the owned execution's exact request, lifecycle phase and any retained capture. Clients verify the response hash, execution/workspace identity, request hash and complete capture coverage. A capture can be present while the phase is still `dispatching` or `stopping`; its presence does not establish resource cleanup or final cost settlement. Terminal phases are server-authored lifecycle observations; clients do not independently verify cleanup or billing receipts. This read starts no compute. Check current capability discovery for exact execution availability.

## Managed activation lifecycle

For example, configure one prompt and compare Off with two signed neuron doses. Discover capabilities for the exact base/tokenizer first. On a compatible host, compile the raw form, prepare the compiled request with a name, Project and maximum spend, then inspect the retained preparation before explicitly starting it.

| Step | TypeScript training client | Official CLI training command |
| --- | --- | --- |
| Compile bounded prompts and coordinates | `compileModificationExecution(input)` | `hosted-compile-modification <input.json>` |
| Prepare exact compiled inputs and cap | `prepareModificationExecution(input)` | `hosted-prepare-modification <input.json>` |
| Explicitly approve the retained preparation | `startModificationExecution(input)` | `hosted-start-modification <input.json> --yes` |
| Cancel the retained execution | `cancelModificationExecution(input)` | `hosted-cancel-modification <input.json>` |
| Discover creator-owned metadata history | `listModificationExecutions(teamId, query)` | `hosted-modification-executions` |
| Read exact request and capture | `getModificationExecution(teamId, executionId)` | `hosted-modification-execution <execution-id>` |

CLI commands take `--team-id <id>` and support `--json`. Native Python exposes the corresponding snake_case methods in both sync and async clients. Read installed help and typed input schemas before creating a command. Preparation pins its inputs and cap; Start retains the preparation's exact ID, revision and plan hash plus a stable operation ID. Retrying an uncertain command must use that original command. Compilation and preparation start no GPU work; Start crosses the funded execution boundary. Cancellation can remain in progress while resources are being cleaned up.

The history list contains bounded metadata, not capture blobs. Open the exact execution for verified results. Preserve account, workspace, Project and query filters across pagination; a cursor from another scope cannot be reused. Unsupported capability or unavailable tokenizer evidence must leave authoring intact and execution unavailable.

Include `sourceForm` in a preparation to retain the original text and controls with the execution. The host recompiles it against the exact tokenizer before accepting fresh preparation. History can then copy those settings into a new experiment; the new experiment requires its own preparation and approval. Requests authored directly as token IDs can omit this field. Clients do not attempt to reconstruct the original text from token IDs.

For a verified result, the TypeScript helper `verifyAndCompareActivationReferenceResult` compares a selected baseline/profile or profile/profile pair. Activation deltas require the same causal token prefix. Once generated tokens diverge, later activations are identified as incompatible rather than subtracted by position. Dose deltas require matching model, normalization, token scope and coordinates. These comparisons contain no quality grades.

## Save a steering Model

On a host implementing steering publication, `saveModificationResultModel` saves one exact non-baseline variant from a completed managed steering execution. Supply its execution ID, result hash, variant ID and profile hash, a name, and the target Model revision—or a null target and revision zero for a new Model. Keep the original operation ID when reconciling an uncertain save. Saving creates no serving allocation.

Use `getSteeringProfile` and `listSteeringProfiles` to read retained publications, `archiveSteeringProfile` to prevent new use, and `modelVersion` to read the Model's exact saved version. Native Python exposes corresponding snake_case methods in both clients. Steering versions retain their exact base, intervention and source evidence; training versions retain their checkpoint identity. A saved steering version does not imply that an inference destination can execute it. Fixed-reference calibration still requires custody of the original calibration artifact; observed scales cannot replace it.

### Saved steering sources and calibration custody

A saved steering version can seed a neuron experiment through `activationFormFromSteeringVersion` and `experimentStartingModelFromSteeringVersion`. Drafts retain compact immutable references; compilation must resolve the verified full version. Results retain a separate Off control and the exact original profile, alongside any edited variants. Edits replace the profile rather than implicitly composing interventions. Other methods reject a saved steering source until their runtime supports it.

`client.savedModelServing(modelProjectId, {teamId, versionHash})` reads the applicable training, steering or Engram serving projection. `controlSteeringModelServing` uses an exact version and revisioned command. The APIs distinguish request defaults, an explicit Off selection and a publication override. Serving availability still depends on a qualified runtime; publication does not make a model deployable by itself.

The Python dense reference executor exposes `calibrate(request)` to measure an original fixed residual reference from the exact model and tokenized source. Its export includes the original artifact and measured implementation identity. `importNeuronCalibration`, `getNeuronCalibration`, `listNeuronCalibrations` and `archiveNeuronCalibration` retain that export in the authorized workspace. Import establishes custody, not runtime qualification. Metadata history excludes tokens and numerical artifacts; exact reads require authorization. These interfaces are implementation plumbing and do not imply a hosted runtime has completed qualification.

## Conditional-memory lifecycle

The Engram path implements an independent post-hoc memory adapter for an exact Qwen3-8B BF16 target. It uses a supervised objective to train additional n-gram tables, projections and gates while freezing the base weights. The module participates in forward passes during both training and inference; only training updates its learned weights. This is separate from native DeepSeek conditional memory and from neuron steering. Query exact runtime availability; training, retained artifacts, independent reload, serving and model quality require their own evidence.

For example, select a reviewed supervised batch of fictional product-support examples. On a qualified host, train a memory module, inspect its retained training result, save the exact module as a Model version and activate that version for serving. Compare held-out support questions and unrelated questions with the module enabled and Off. This example describes the intended workflow, not a measured quality result.

| Step | TypeScript training client | Official CLI training command |
| --- | --- | --- |
| Check exact model/runtime support | `engramExecutionCapability(query)` | `hosted-engram-capability <query.json>` |
| Compile and prepare reviewed data/settings | `compileEngramExecution(input)`, `prepareEngramExecution(input)` | `hosted-compile-engram <input.json>`, `hosted-prepare-engram <input.json>` |
| Explicitly start or cancel | `startEngramExecution(input)`, `cancelEngramExecution(input)` | `hosted-start-engram <input.json> --yes`, `hosted-cancel-engram <input.json>` |
| Read results or owned history | `getEngramExecution(teamId, id)`, `listEngramExecutions(teamId, query)` | `hosted-engram-execution <id>`, `hosted-engram-executions` |
| Save the exact completed result | `saveEngramResultModel(input)` | `hosted-save-engram-model <input.json>` |
| Activate or stop exact-version serving | `controlEngramModelServing(modelProjectId, request)` | `hosted-control-engram-serving <command.json>` |

CLI commands take `--team-id <id>` and support `--json`; serving activation requires `--yes`. Native Python provides the corresponding snake_case operations in both sync and async clients. Use installed help and typed schemas for the complete request. Retain original operation IDs when reconciling uncertain replies. Preparing and saving create no serving allocation; Stop can remain pending while requests and GPU cleanup finish.

Training uses the existing reviewed supervised-data authority. Continuation selects an exact committed parent module and starts a fresh optimizer; it does not resume an interrupted optimizer or RNG state. Module dimensions and indexing follow the supported configuration. A saved artifact retains all learned module state and exact base/tokenizer pins. An Off inference comparison still retains that exact saved Model identity; it does not silently route to an unrelated base endpoint. Arbitrary stacking, quantization and other checkpoints are not implied.

## Typed decision models

Decision models score bounded choices from typed state and named questions.
The selected source is the Apache-2.0
[Bespoke-Nimble-9B release](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B/tree/e93fabce8fcee46e7e8b45e2d955b8a4f0035917),
including its released tokenizer/template, over the separately pinned
[Qwen3.5-9B backbone](https://huggingface.co/Qwen/Qwen3.5-9B/tree/c202236235762e1c871ad0ccb60c8ee5ba337b9a).
Its full conditional-generation source identity is preserved. This is a typed
candidate scorer, not generated chat JSON. Contracts and CLI integration are
implemented in source; a compatible host and exact qualified decision runtime
are required. Query current capability discovery for that exact source. Source
delivery alone establishes no training, reload, quality or serving performance.

For example, route a fictional support ticket to a team and assess its urgency:

```json
{
  "state": {
    "ticket": {
      "subject": "Duplicate subscription charge",
      "body": "Two charges appeared for this month's subscription. Please refund the duplicate."
    }
  },
  "questions": [
    {
      "id": "queue",
      "type": "choice",
      "description": "Team responsible for resolving the request.",
      "choices": [
        {"value": "billing", "description": "Payments, invoices and refunds."},
        {"value": "technical", "description": "Product defects and integration failures."},
        {"value": "account", "description": "Sign-in and account-access problems."}
      ]
    },
    {
      "id": "urgency",
      "type": "integer_levels",
      "description": "Operational urgency supported by the ticket's facts.",
      "choices": [
        {"value": 0, "description": "Routine request without loss of access."},
        {"value": 1, "description": "Material disruption requiring prompt attention."},
        {"value": 2, "description": "Active outage or ongoing severe harm."}
      ]
    }
  ]
}
```

Boolean questions use two ordered choices, `false` then `true`. All questions
retain authored order, distinct values and descriptions. Scoring returns every
candidate's finite logit and temperature-1 softmax probability, its selected
value, and the probability-weighted expected level for integer questions. These
are model outputs, not measured real-world calibration or a quality guarantee.

Training uses the same state/questions with separately reviewed targets, such
as `[{"questionId":"queue","value":"billing"},
{"questionId":"urgency","value":0}]`. Targets remain outside the prompt and
must be approved and sealed by the existing Dataset review/batch owner. Raw
unreviewed rows cannot substitute for that batch. The training contract requires
candidate-only cross entropy over the actual released PEFT matrices while
freezing the complete backbone. It does not invent a training Job or
label the classifier as an Engram artifact.

For the Dataset itself, put the object above in the task's `input` and use
`{"queue":"billing","urgency":0}` as `expectedOutput`; the approved demonstration
must contain that same JSON object. The compiler derives the ordered targets.
If the task definition has instructions, retain their exact text in
`state.instructions` so training and scoring use the same context. Other
policy-visible context and privileged grading context are not accepted as
unrepresented Decision inputs.

| Step | TypeScript training client | Official CLI training command |
| --- | --- | --- |
| Check exact source/runtime support | `decisionExecutionCapability(query)` | `hosted-decision-capability <query.json>` |
| Compile train or score authoring | `compileDecisionExecution(input)` | `hosted-compile-decision <input.json>` |
| Prepare bounded execution | `prepareDecisionExecution(input)` | `hosted-prepare-decision <input.json>` |
| Explicit Start or Cancel | `startDecisionExecution(input)`, `cancelDecisionExecution(input)` | `hosted-start-decision <input.json> --yes`, `hosted-cancel-decision <input.json>` |
| Read exact results/history | `getDecisionExecution(teamId, id)`, `listDecisionExecutions(teamId, query)` | `hosted-decision-execution <id>`, `hosted-decision-executions [--mode train\|score]` |
| Save completed training | `saveDecisionResultModel(input)` | `hosted-save-decision-model <input.json>` |
| Read/control exact-version serving | `decisionModelServing(modelProjectId, query)`, `controlDecisionModelServing(modelProjectId, request)` | `hosted-decision-serving <selection.json>`, `hosted-control-decision-serving <command.json>` |
| Score a saved version | `scoreDecisionModel(modelProjectId, request)` | `hosted-score-decision <command.json> --yes` |

All commands use `--team-id <id>` and the configured account/home; `--json`
retains structured output. Capability queries select the Nimble repository,
revision and tokenizer revision above, rather than assigning its tokenizer to
the Qwen repository. Raw train forms contain a reviewed batch and eight editable
training settings; raw score forms contain `stateJson`, questions and limits.
The host resolves full source manifests. Preserve the compiled request and
form/input hashes, then explicitly prepare and approve the exact plan/cap.
Preparing a plan and saving a Model do not activate serving.

Save Model retains the actual completed training result, four-file decision
artifact, original request and exact Model revision. Continuation selects that
artifact and starts a fresh optimizer. A saved source keeps its compact Model
ID/version/artifact/model-hash pin through subsequent train or score forms; no
operation silently falls back to its frozen backbone. Use
`training hosted-model-version <id> --version-hash <sha256>` for an exact
historical version. Existing standalone draft commands retain `decisionForm`,
including incomplete edits within the existing 32 KiB draft limit. Larger
inference inputs use the separately bounded compile/scoring request. Copying settings creates a new draft and requires
fresh compilation/preparation rather than replaying an old approval.

Serving reads take `{modelProjectId, versionHash}`. Control files contain
`{modelProjectId, request}`, where the request uses
`openpond.decisionModelServingControlRequest.v1`, `teamId`, original
`operationId`, exact `versionHash`, `expectedRevision`, action `activate` or
`stop`, and `idleTimeoutSeconds` (60–3600). Activation requires `--yes`; Stop
does not. Routing, shared capacity, active/unsettled requests and cleanup are
reported separately. Stop acceptance is not proof of released capacity or
settled billing. The `decision:model:<id>` binding is not a chat alias.

Saved-version scoring also takes `{modelProjectId, request}`. Its request uses
`openpond.decisionModelScoreRequest.v1`, `teamId`, a stable `requestId`, exact
`versionHash`, the unlabeled `input` above, and
`limits: {maximumPromptTokens, maximumForwardTokenWork, maximumDurationSeconds}`.
There is no training Dataset or target in this inference request. The typed
`/v1/training/models/:id/decisions` endpoint returns verified full distributions
with exact model/artifact/runtime and pool/binding receipt evidence. It never
substitutes sampled text or a different/latest version.

After an uncertain reply, retain the same configured account, workspace,
operation ID and exact command. Scoring retains its original `requestId` and
complete version/input/bounds. Changing inputs requires a new request; unknown
issued work must reconcile before another paid attempt. No CLI mutation is
automatically retried.

## Selective neuron training

Neuron training uses the configured training account, reviewed target and
background Dataset batches, preparation approval, cancellation, artifact custody
and saved Model owners. Availability requires an exact qualified runtime.

| Operation | Selective neuron SDK |
| --- | --- |
| Capability | `neuronTrainingExecutionCapability(query)` |
| Compile raw reviewed form | `compileNeuronTrainingExecution(input)` |
| Prepare | `prepareNeuronTrainingExecution(input)` |
| Start approved plan | `startNeuronTrainingExecution(command)` |
| Cancel | `cancelNeuronTrainingExecution(command)` |
| Exact result | `getNeuronTrainingExecution(teamId, id)` |
| Creator-owned history | `listNeuronTrainingExecutions(teamId, query)` |
| Save completed result | `saveNeuronTrainingResultModel(input)` |
| Exact serving state | `neuronTrainingModelServing(modelProjectId, query)` |
| Activate/stop | `controlNeuronTrainingModelServing(modelProjectId, request)` |

Use a reviewed target batch containing desired behavior, named background-domain
batches and optional preservation examples. Selection records target/background
activation and gradient criteria; the optimizer changes only the chosen
`down_proj` columns. The retained delta can be saved and served against the exact
base. Training from an already modified neuron Model is unsupported.

Use the official CLI's `hosted-neuron-training-capability`,
`hosted-compile-neuron-training`, `hosted-prepare-neuron-training`,
`hosted-start-neuron-training`, `hosted-cancel-neuron-training`,
`hosted-neuron-training-execution`, `hosted-neuron-training-executions`,
`hosted-save-neuron-training-model`, `hosted-neuron-training-serving` and
`hosted-control-neuron-training-serving` commands. Pass `--team-id <workspace-id>`
and `--json`; paid Start and serving activation also require `--yes`.
Use the running app's configured `--home <selected-home>` when reusing its
account. Read `openpond training --help` for exact syntax.

After a lost acknowledgement, reconcile the same immutable operation and exact
command. Tensor upload, cleanup, settled billing and active serving are separate
states. Optimization losses do not establish held-out quality or improvement.
