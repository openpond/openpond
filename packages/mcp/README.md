# @openpond/mcp

Internal adapter for OpenPond's hosted OAuth MCP connection over supported OpenPond CLI/API workflows. Ponder is OpenPond's model training product. This workspace package provides the tool catalog, public SDK adapters, validation, structured results and errors, and stateless Streamable HTTP transport. It is delivered with the hosted application or as an exact internal build artifact; it has no independent npm publication or version-release requirement. The existing MIT license and attribution remain in [LICENSE](LICENSE).

The exported request handler can be embedded in an MCP host. Configure its URL and authentication through your MCP client. A host supplies the transport adapter and authorization; the package does not configure clients automatically.

## Connect an application to the hosted MCP

Customers add the published API deployment's `/mcp/app` URL in their MCP application and complete OpenPond OAuth consent. No local MCP process, npm package, or Desktop installation is required for this connection. The workspace and granted capabilities are selected during consent; access can be revoked from Console → Integrations → External agents.

For example, OpenCode uses a remote server configuration:

```json
{
  "mcp": {
    "openpond": {
      "type": "remote",
      "url": "https://api.openpond.ai/mcp/app",
      "enabled": true
    }
  }
}
```

The example uses the production API host. Follow the published availability and tested-client instructions before connecting. Keep access tokens and API keys out of shared configuration and prompts.

This private workspace package implements the hosted route and supports reviewed internal host integrations. OpenPond Desktop uses its bundled CLI and workflow skills for its own operations; it does not need to connect to its own MCP.

## Hosting contract

```ts
import { handleOpenPondMcpRequest } from '@openpond/mcp';

// `verified` must come from the host's OAuth resource/grant verifier.
const response = await handleOpenPondMcpRequest(request, {
  baseUrl: configuredApiBaseUrl,
  context: {
    userId: verified.userId,
    teamId: verified.teamId,
    scopes: verified.scopes,
    authorize: requiredScopes => verifyCurrentGrant(requiredScopes),
  },
  apiKey: credentialForThisSameAuthorizedPrincipal,
});
```

The hosting application must verify issuer, exact resource audience, expiry, active grant, current workspace membership and operation scopes before dispatch and in `authorize` on every discovery/call. Do not exchange a customer grant for an operator credential. An API-key adapter supports reviewed host integrations but does not implement the hosted OAuth connection contract.

A first-party host may instead supply an authenticated `fetch` adapter. Without `apiKey`, the package removes the SDK's compatibility authorization marker before calling that adapter; there is no implicit unauthenticated network fallback. The host must revalidate each request, bind its workspace, allow only reviewed public API routes, and run the same underlying resource/domain permissions and spend admission. OAuth bearer passthrough is not supported.

Transport is stateless, using MCP SDK 1.32.1 and the versions negotiated by that SDK. Accepted work belongs to durable API services. Disconnecting or restarting MCP does not cancel it. `tools/list` is authorized and ordered by stable tool name. Discovery uses a 1 MiB response budget, reserving at least 1 KiB for the JSON-RPC envelope and counting the tools array, separators and any continuation cursor in the remaining bytes. It has no arbitrary tool-count cap. The current catalog fits in one result for clients that discover tools once; clients must follow `nextCursor` when a future catalog exceeds the byte budget. A single schema exceeding that limit fails explicitly. Results use `{ result: ... }` structured content (the exported `OpenPondMcpStructuredResult<T>` retains the public SDK result type). Learning discovery uses compact resource/operation identity envelopes instead of repeating the full polymorphic evidence schema on every tool; complete results are still validated by the full SDK schema and retained unchanged. Results retain the SDK's verified identities and evidence. Large results fail explicitly rather than truncating evidence; use a smaller supported page or the canonical Console resource. Mutations conservatively advertise `idempotentHint: false` unless their specific adapter marks a durable retry contract.

## Workflow coverage

| Group | Supported tools and authority |
| --- | --- |
| Connection | Fixed account/user ID, workspace ID and granted scopes; no workload is launched. |
| Projects | List/get/save/archive with revisions, owner scope and operation IDs. |
| Datasets | List/get/save/validate/publish/begin-version, exact versions, bounded task append and released population previews, training-review submission, preparation grants/runs/actions/candidates and immutable taskset packages/catalog. |
| Graders | Released catalog, versions and usage; authoring drafts/checks/publication use the shared learning contracts. |
| Evals | Defaults, Harness source discovery/preparation, launch/list/status/result/diagnostics, compatible comparison, duplicate/cancel, scoring passes and shared comparison budgets. |
| Models | Configuration inventory/readiness/check/save, explicit initial learning creation, portable source sync, ordinary result saving and exact saved-version/lineage reads. |
| Ponder | Estimate/prepare/start/cancel, input artifact upload, durable jobs/status/recovery/graceful stop, bounded events/logs, outputs, evaluation tasks, acceptance snapshots and candidate review decisions. |
| Training adapters | Separate Engram, Decision and selective-neuron capability, compile, prepare, history, read, start, cancel and Model-save tools. Decision supports typed train/score execution modes and saved-version scoring on existing authorized capacity. |
| Learning | Explicitly retained grader/format drafts, checks and checked-grader publication; source/definition/binding/asset/policy publication; intake preview/import; example/feedback/admission/batch/grade and bounded iteration controls. Pinned reads retain the training dependency closure. Policy publication and Model initial learning require separate learning authority. Dataset preparation start/resume/release require both execute and publish authority because the approved finish policy can publish automatically. |
| Training authoring and credit | Saved experiment drafts, model-first SFT/GRPO preparation, ordinary execution history, verified training results and Model saving, bounded Dataset task append/review, authorized prepaid balance and advisory funding. |

App scopes are `app:read`, `app:write`, `app:execute`, `app:publish`, `app:cancel`, `app:review` and `app:learning`. They are separate from organization-action MCP scopes. Tool annotations describe effects and grant no authority. Publish, launch, candidate review and learning policy publication remain separate operations. Serving activation and general compute administration are not exposed.

Standalone human-review management, correction-accounting writes, bulk learning publication, unchecked direct grader publication and internal chain/consumption/reservation/dispatch/schedule inventories are absent from discovery and dispatch. The checked grader draft → check → result → publication path and Dataset/example admission remain available. Adding an SDK action or resource kind does not automatically expose it through MCP. Historical Model artifacts remain readable for exact lineage.

Keep the original `operationId`/submission identity, expected revision/version, source release/hash and approved budget on retries. Inspect the retained operation/job after uncertain delivery. Do not replace an identity to work around a conflict. Training logs/events use bounded offset windows over retained append-only history; other APIs retain their native cursor/revision contracts.

## CLI/API map

These mappings follow the checked-in CLI command reference; the MCP accepts its typed JSON content instead of CLI input-file paths.

| CLI/API workflow | MCP entry points |
| --- | --- |
| `openpond account` and workspace selection | `connection_context` returns the fixed authorized IDs/capabilities. Account billing/profile administration is excluded. Workspace selection happens during OAuth consent, never through a tool argument. |
| `openpond datasets list/read/save/validate/publish --team …` | `datasets_list/get/save/validate/publish`; exact version and operation tools support read-back/recovery. |
| `openpond datasets preparation …` | `dataset_preparations_*`, `dataset_preparation_grants_*` and retained operation/candidate reads. |
| Released grader discovery and shared authoring API | `graders_catalog/versions/usage`, `learning_save_draft`, `learning_queue_reward_check`, `learning_publish_checked_reward`, and typed release publication. |
| `openpond experiments prepare-harness/run/read/list/status/diagnostics/cancel/duplicate/score/passes/pass/pass-result/result/compare/case --team …` | Corresponding `experiments_*` and `scoring_passes_*` tools, including exact retained case evidence. |
| `openpond training hosted-models/hosted-model/hosted-sync-model` | `models_list/get/sync` and configuration tools. |
| `openpond training hosted-prepare/hosted-start/hosted-stage/hosted-submit` | `training_prepare`, `training_preparation_start`, `training_artifacts_stage`, `training_jobs_create`. |
| `openpond training hosted-status/hosted-watch/hosted-logs/hosted-events/hosted-cancel/hosted-recover/hosted-artifacts` | `training_jobs_get/events/logs/cancel/recover_checkpoint/outputs`; bounded reads replace watch loops. |
| `openpond training hosted-evaluation-tasks/hosted-corrections/hosted-learning-inspect` | `training_evaluation_tasks`, fixed-workspace `learning_correction_metrics`, policy list/inspection and task queue inspection. |
| Public post-training evaluation SDK | `training_post_evaluation_attach/get/start/retry/cancel`; evaluation never implicitly reruns training. |

## Training workflow host requirements

The focused authoring tools bind the workspace from the verified connection, rather than accepting a destination workspace from the caller. SDK request/receipt hashes, expected revisions, exact source identities and current actor ownership remain enforced. Draft saving exposes evaluation, SFT, GRPO, Engram, Decision and selective-neuron authoring intents; saving an intent is not evidence that a method-specific executor is available. AlphaEdit and activation authoring are excluded from this draft-save tool.

| Tools | Public API routes | Required app authority |
| --- | --- | --- |
| `experiment_drafts_list/get` | `GET /v1/training/experiment-drafts[/<id>]` | read |
| `experiment_drafts_save/archive` | `POST /v1/training/experiment-drafts` and `/<id>/archive` | write |
| `training_prepare_experiment` | `POST /v1/training/preparations/from-draft` | write; preparing does not launch |
| `training_executions_list` | `GET /v1/training/executions` | read |
| `training_jobs_result`, `models_saved_get` | `GET /v1/training/jobs/<id>/result`, `/v1/training/models/<id>` | read |
| `training_jobs_save_model` | `POST /v1/training/jobs/<id>/model` | write; saving does not activate serving |
| `datasets_add_task` | `POST /v1/dataset-workspaces/<id>/tasks` | write; reuse the exact operation ID on retry |
| `datasets_submit_training_review` | `POST /v1/training/dataset-reviews` | review; submission does not grant admission or start training |
| `account_credit_balance` | `GET /v1/account/balance` | read plus current workspace billing-role checks |
| `training_funding_preview` | `POST /v1/training/funding/preview` | read plus canonical training-funding permissions |
| `training_billing_handoff` | `POST /v1/training/funding/handoff` | write plus current billing-role checks; creates no payment |

Hosts must explicitly admit these route/method/effect combinations; a blanket training-prefix grant is insufficient. Refresh the OAuth read consent description to include permitted credit/funding observations. Balance output strips billing-account identifiers and preserves the decimal USD amount, signed cent balance and observation time. This small bounded public-API reader covers the SDK's current account-balance client gap. Restricted members can receive advisory funding status without private totals where the service permits it. Funding previews reserve no credit. The Billing handoff returns an expiring permission-checked web destination and never purchases credit.

## Method lifecycles and training dependencies

Each prefix `training_engram`, `training_decision` and `training_neuron` has eight named tools. They use the corresponding typed SDK client; a memory module, Decision adapter and neuron patch are never parsed as interchangeable results.

| Suffix | Canonical route | Effect and retry boundary |
| --- | --- | --- |
| `_capabilities` | GET `/v1/training/modification-capabilities/engram`, `/decision` or `/neuron-training` | read; exact source, actor, expiry and source-validation/GPU-qualification identity |
| `_compile` | POST `/v1/training/modification-executions/compile`, exact typed method/form | read; resolve authorized source without allocating compute |
| `_prepare` | POST `/v1/training/modification-executions/prepare`, exact typed method/request | write; retain operation ID and bounded plan; does not launch |
| `_list` | GET `/v1/training/modification-executions`, fixed typed method filter | read; private owner, workspace, cursor and page bounds |
| `_get` | GET `/v1/training/modification-executions/<id>` | read; exact typed execution and fully verified retained result |
| `_start` | POST `/v1/training/modification-executions/<id>/start` | read + execute; typed owner read before mutation; original operation, plan/price hash and expected revision |
| `_cancel` | POST `/v1/training/modification-executions/<id>/cancel` | read + cancel; typed owner read, retained operation and expected revision |
| `_save_model` | POST `/v1/training/modification-executions/<id>/model` | read + write; typed owner read, exact result/artifact hashes and Model revision; no activation |

The existing domain owner reconciles accepted operations before new admission. A typed control preflight does not replace domain revision, ownership, qualification or spending checks. No generic modification dispatcher, unsupported recovery endpoint, fresh AlphaEdit authoring or activation experiment is exposed.

`models_version_get` reads GET `/v1/training/models/<id>/version` with an optional exact `versionHash`. Saved parents and continuation must retain those verified versions and their actual artifacts. Use the supported method's source/form contracts; do not substitute an ancestor backbone or invent optimizer-state continuation.

`decision_models_serving` reads existing capacity/readiness for an exact saved Decision version. `decision_models_score` uses POST `/v1/training/models/<id>/decisions` with typed choices, pinned version, bounded inference limits and a stable request ID. It requires execute authority and existing authorized capacity, may incur inference charges, and never provisions a pool. Retry the same request ID after uncertain delivery. Generic chat output is not a Decision probability receipt.

`training_save_learning_policy` uses POST `/v1/training/preparations/from-draft/learning` with write + learning authority. Policy saving/pausing is separate from manual start; enabling it authorizes future work only within its explicit policy bounds. `learning_preview_intake` previews supplied text before `learning_import_intake` creates review resources. Intake import and `datasets_add_task` are distinct paths; neither grants training admission. `datasets_population` reads released membership/splits or policy-visible inputs with a maximum 100-task page; gold answers and privileged context remain sealed.

Compare quality only through compatible retained evaluation manifests using `experiments_compare` and exact scoring-pass results. Training loss from different methods is not interchangeable evaluation evidence. Saved-model inference/evaluation requires preexisting authorized serving capacity; absent capacity is an explicit unavailable state, never an implicit provisioning request. Capability/source validation and protocol checks alone do not establish numerical training quality or a qualified runtime.

Hosts can use the exported `trainingLearningCommandScopes` and `assertTrainingLearningRead` guards to enforce the same reviewed training action/resource subset as discovery. They must still validate the fixed body scope and revalidate current grant/membership and canonical domain authority on every request. Human-review and removed learning endpoints must not remain reachable through a general prefix grant.

## Boundaries and delivery checks

The adapter requires `openpond-sdk@^0.12.24` for its current draft, training-result/model-save, funding, Dataset-ingestion/review and learning contracts. Preserve that compatible dependency floor and verify the exact internal archive in an isolated consumer. The dependency cohort can come from its supported registry releases or explicit local archives; MCP itself needs no npm publication. See [internal delivery and artifact integration](RELEASING.md).

The tool catalog excludes local filesystem access, shell execution, desktop-session management and account or infrastructure administration. Asset uploads accept the existing typed hash-verified upload/package contracts, never a path interpreted on the MCP host. Profiles/Skills/Harness authoring and published organization actions remain under their existing separate interfaces; released Harness evaluation targets are supported here.

Hosts must implement OAuth discovery, token refresh and revocation, and verify workspace isolation and client interoperability before offering a connection. Keep authorization checks and approved budgets in force for every operation.

From the repository root, build and check the focused adapter and its installed artifact:

```sh
node scripts/run-typescript.mjs tsc -p packages/mcp/tsconfig.json
node --test packages/mcp/test/protocol-boundary.test.mjs
node packages/mcp/scripts/check-installed-consumer.mjs --local-dependencies
npm pack ./packages/mcp --dry-run --ignore-scripts
```
