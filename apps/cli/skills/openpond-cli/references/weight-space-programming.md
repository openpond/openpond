# Weight-space programming

Weight-space programming is direct parameter editing controlled by this local agent. OpenPond holds the target checkpoint remotely; the local agent never needs to download it. It is a workflow, not a LoRA adapter, SFT/GRPO optimization loop or a hosted teacher. Teacher identity in the request is declared provenance; do not call it a hardware/location attestation.

Check `openpond training --help` against the installed CLI. Use the app-supplied scoped executor and bundled CLI in native chat, retaining its configured home and account. External agents use the same official CLI with their selected home. Never create custom authentication or duplicate API scripts.

1. Resolve the user's exact supported source and tokenizer. `training hosted-weight-space-capability <query.json> --team-id <id> --json` reports the registered runtime, editable model and limits. Unavailable means stop; a supported base or packaged worker does not establish GPU qualification. Never substitute another base automatically.
2. Create a `WeightSpacePrepare` JSON file with the exact capability model, local-agent teacher provenance, objective, explicitly reviewed development/preservation prompt panels, optional frozen-evaluation reference, fixed generation settings, duration/idle/work/output/candidate limits and positive spending bound. `training hosted-prepare-weight-space <input.json>` starts no compute. Keep the entire returned receipt.
3. Start only an authorized workload with `training hosted-start-weight-space <control.json> --yes`. Copy the original execution ID, expected execution revision, plan hash and approved price/spend into the canonical start command. Starting allocates once. Do not use a larger limit or a fresh operation ID to recover uncertainty.
4. Read `training hosted-weight-space-session <id>` until the retained session is ready. Commands use the **session revision** and current candidate hash; lifecycle controls use the **execution revision**. They are different clocks. Keep the original command JSON and operation ID.
5. Submit through `training hosted-weight-space-command <command.json>`. Actions: `catalog` pages tensor names/shapes; `inspect` returns selected column statistics/values; `program` executes the typed tensor program; `code` compiles the supported Python-like tensor language below; `evaluate` runs a declared development or preservation panel; `select` returns to a retained candidate; `finalize` exports the selected patch and closes editing. A receipt can be queued. Read its result using `training hosted-weight-space-command-result <session-id> --operation-id <id>`; polling never executes another command. `training hosted-weight-space-history <id> --after-revision <n> --limit 5` pages retained hypotheses, programs and results.
6. After an uncertain response, recover that same operation first. Retrying the original JSON under the same ID reconciles its receipt. A new command requires the latest session revision/current candidate. Rejected edits preserve the parent candidate while already consumed work remains charged. A worker loss without positive cleanup/output proof is unavailable evidence; never reconstruct success or launch a replacement automatically.
7. Compare the original base and selected candidates on the same declared prompts and generation settings. Keep unrelated preservation prompts. The editing `evaluate` action cannot request arbitrary or frozen panels. For a declared frozen Dataset release, finalization runs the pristine base and selected candidate on the same trusted policy-visible inputs using fixed generation settings. Reserve enough forward work for both passes. This closes editing on success, failure or interruption; recover the original operation instead of opening another finalization to obtain feedback. Private answers and graders stay outside the worker and editing context. A frozen reference or generated answer alone is not a quality score.
8. Finalize a nonempty selected patch, then read its completed execution/result and actual cleanup. `training hosted-save-weight-space-model <input.json>` saves the exact result/artifact hashes as a Model version using the existing expected Model revision. It never starts serving. Serving requires a separately qualified exact method/runtime and its own accepted usage approval. Do not claim availability from a saved patch. Use `training hosted-weight-space-serving <input.json>` to inspect the exact saved version and `training hosted-control-weight-space-serving <input.json> --yes` for a separately authorized activation.
9. Cancel with `training hosted-cancel-weight-space <control.json>` and read actual stopping/cancelled state and cleanup. Disconnecting the local agent does not cancel work; original duration, idle, work, spend and provider cutoff still apply. Allocated startup and idle time can be billable. Teacher-provider reasoning charges are separate from remote compute.

The first implementation reads bounded slices of any named model parameter and writes at most the approved number of MLP down-projection columns on the exact dense BF16 Qwen3-8B source. Analysis uses FP32; writes become exact BF16 replacements. Candidates are immutable compact patches over an unchanged original checkpoint. This does not reproduce unrestricted research notebook access or promise general model improvements.

## Preparing without a source checkout

The installed CLI and this reference contain the preparation contract. Do not
search the application's repository or assume developer source paths exist.
First read `account context --json`, `datasets context --local --json` in native
chat, and `training hosted-model-candidates --team-id <id> --json`. Preserve the
selected workspace. Resolve the requested candidate's exact source, checkpoint,
tokenizer and chat-template identity from that catalog.

The capability input is a plain JSON object, with **no schemaVersion wrapper**:

```json
{
  "teamId": "<selected workspace>",
  "modelId": "<exact candidate modelId>",
  "source": "managed",
  "revision": "<catalog checkpoint revision>",
  "tokenizerRevision": "<catalog tokenizer revision>",
  "chatTemplateHash": "<catalog chat-template hash>"
}
```

`source` accepts `managed`, `local` or `builtin`; use the catalog value.
`revision`, `tokenizerRevision`, `chatTemplateHash` and `modelAssetId` are optional
query fields: include catalog values when present and omit null values. Never
invent hashes. The result's `execution.state` determines whether preparation can
continue. If unavailable, report its `code` and exact `reason`; there is no
accepted editing session to attach. A ready result contains `execution.model`
and `execution.limits`; copy the complete model object unchanged into the request.

`hosted-prepare-weight-space` accepts a plain object containing exactly:

| Field | Value |
| --- | --- |
| `teamId`, `operationId`, `projectId`, `name` | Selected workspace, stable operation ID, selected Project ID or null, and experiment name. |
| `method` | `"weight_space_programming"`. |
| `query` | The exact accepted capability query above. |
| `maximumSpendUsd` | The user's positive total ceiling as a decimal **string**, at most six decimal places; no dollar sign. |
| `request` | The object described below; it has its own schemaVersion. |

The nested `request` contains `schemaVersion: "openpond.weightSpaceRequest.v1"`,
the complete ready capability `model`, and `teacher: {controller: "local_agent",
providerId, modelId, sessionId}` using the actual answering agent and chat IDs.
It also contains `objective`, `panels`, `frozenEvaluation`, `generation` and
`limits`. Never add `sourceForm`.

Each panel is `{id, source, role, prompts}`. Use distinct panel IDs, role
`"development"` or `"preservation"`, and 1–64 prompts each. A prompt is
`{id, text}` with optional `system`; prompt IDs are unique within each panel.
There are 1–4 panels and at least one development panel. For user-reviewed
inline prompts use `source: null`; otherwise pin `{id, revision, contentHash}`.
`frozenEvaluation` is null or a separate exact `{id, revision, contentHash}`
Dataset release that is never copied into editor-visible panels.
`generation` is `{maxOutputTokens, seed, sampling: "greedy_v1"}` with 1–2048
output tokens and integer seed 0–2147483647.

All ten integer `limits` fields are required. Use the tighter of the user's
approved bound and the corresponding ready capability bound. The hosted work
duration begins at native-command issuance: checkpoint loading and verification
consume that time, and readiness does not reset it. Idle limits bound inactivity
between commands once the session is ready, and must fit within duration. Plan
enough approved time for loading, agent reasoning, edits, both frozen passes,
checkpoint verification, export and transfer. Finalize with that headroom still
available; a later receipt cannot authorize a new upload after cutoff. Resolve
missing user preferences in chat before paid start, while keeping preparation
free of compute.

| Limit | Schema range |
| --- | --- |
| `maximumDurationSeconds` | 1–21600 |
| `maximumIdleSeconds` | 1–900, no greater than duration |
| `maximumCommands` | 1–512 |
| `maximumCandidates` | 1–64 |
| `maximumPatchColumns` | 1–128 |
| `maximumTensorElements` | 1–1048576 |
| `maximumReturnedValues` | 1–4096 |
| `maximumArithmeticWork` | 1–2000000000 |
| `maximumForwardTokenWork` | 1–100000000 |
| `maximumCheckpointBytes` | 1–16777216 |

Keep the whole preparation receipt. Its execution `id`, `revision`,
`plan.contentHash`, `plan.maximumSpendUsd` and `plan.computePrice` identify the
reviewable plan. Successful native-chat preparation attaches that original
execution automatically; verify the attachment and reopen the same execution
if the projection failed. Do not resubmit preparation to repair a sidebar.

Lifecycle controls use `{teamId, id, operationId, expectedRevision, planHash,
action}`. Start adds `approvedMaximumSpendUsd` and, when the plan includes a
compute price, `approvedPriceHash` as the SHA-256 of the exact `plan.computePrice`
object serialized with RFC 8785 canonical JSON; `action`
is `"start"`. Cancellation uses `action: "cancel"`. Copy `expectedRevision`
from the execution and `planHash` from `plan.contentHash`.

Editing commands instead use `{teamId, sessionId, operationId,
expectedRevision, candidateHash, action}` with the current **session** revision
and candidate hash. Add `offset`/`limit` for catalog, `layer`/ordered `columns`
for inspect, `code`/`hypothesis` for code, `program`/`hypothesis` for program,
`panelId` for evaluate or `targetCandidateHash` for select. Finalize has no
additional fields. These commands require separate execution authority; writing
the preparation object does not authorize them.

## Tensor analysis code

The `code` action accepts a bounded Python-syntax tensor program and a hypothesis. It is parsed, not executed as arbitrary Python. There are no imports, arbitrary calls, loops, file/network operations, optimizers, gradients or hidden model forwards. Variables are assigned once and exist within one command. The model and retained candidate patches persist across commands.

Available functions: `read(layer, columns, source="candidate")`, `read_tensor(name, [(start, stop), ...], source="candidate")`, `literal(shape, values)`, `mean_columns(x)`, `normalize_columns(x)`, `singular_vectors(x)`, `transpose(x)`, `write(x, layer, columns)` and `show(x, ...)`. Tensor expressions support `+`, `-`, matrix multiplication `@`, scalar multiplication/division and `.T`. `show` returns bounded values and statistics, not a whole checkpoint. Catalog reads identify actual names and shapes before a slice is requested.

For example, this proposes a projection edit without running training:

```python
w = read(15, [0, 1])
direction = normalize_columns(mean_columns(w))
projection = direction @ (direction.T @ w)
updated = w - projection
write(updated, 15, [0, 1])
show(direction)
```

This illustrates the interface, not an evidence-backed repair. Choose coordinates and operations from inspection and evaluation. Keep baseline/candidate identity, hypothesis, receipts and negative outcomes in the study record.

The current hosted dispatcher uses one GPU-backed worker per session, reused across commands; tensor analysis runs on CPU and model forwards on GPU. The numerical library also runs on CPU. Daytona/CPU hosted execution is not yet wired: do not claim a CPU sandbox is available from these commands.

## Grading retained outputs

Use the existing `experiments score <session-id> --team <id> --input-file <request.json>` operation, after inspecting `experiments score --help`. Set `executionKind: "weight_space"`, `execution: {id: <session-id>, contentHash: <exact-command-result-hash>}`, `weightSpaceOperationId` to that original evaluation/finalization operation, and `weightSpaceTarget` to `"candidate"` or `"baseline"`. The baseline target is available only from a successful sealed finalization. Pin the exact Dataset/grader releases, population and explicit grading spending limit required by the scoring request. Do not add a revision to the immutable execution reference.

Scoring reuses retained outputs and the existing grading owner, budget and verifier machinery; it does not allocate another target-model GPU or rerun generation. Read the original scoring pass/result and compare only matching populations, graders and generation settings. Current Dataset access is required to read evidence or run graders; status and cancellation remain available after access is revoked. Empty runtime qualifications still mean unavailable even when these source operations are packaged.
