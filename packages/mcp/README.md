# @openpond/mcp

Open-source typed MCP tools for supported hosted OpenPond CLI/API workflows. Ponder is OpenPond's model training product. The package provides the tool catalog, public SDK adapters, validation, structured results and errors, and stateless Streamable HTTP transport.

The exported request handler can be embedded in an MCP host. Configure its URL and authentication through your MCP client. A host supplies the transport adapter and authorization; the package does not configure clients automatically.

## Hosting contract

```ts
import { handleOpenPondMcpRequest } from '@openpond/mcp';

// `verified` must come from the host's OAuth resource/grant verifier.
const response = await handleOpenPondMcpRequest(request, {
  baseUrl: 'https://api.openpond.ai',
  context: {
    userId: verified.userId,
    teamId: verified.teamId,
    scopes: verified.scopes,
    authorize: requiredScopes => verifyCurrentGrant(requiredScopes),
  },
  apiKey: credentialForThisSameAuthorizedPrincipal,
});
```

The hosting application must verify issuer, exact resource audience, expiry, active grant, current workspace membership and operation scopes before dispatch and in `authorize` on every discovery/call. Do not exchange a customer grant for an operator credential. An API-key adapter is useful for authorized self-hosting but does not implement the hosted OAuth connection contract.

A first-party host may instead supply an authenticated `fetch` adapter. Without `apiKey`, the package removes the SDK's compatibility authorization marker before calling that adapter; there is no implicit unauthenticated network fallback. The host must revalidate each request, bind its workspace, allow only reviewed public API routes, and run the same underlying resource/domain permissions and spend admission. OAuth bearer passthrough is not supported.

Transport is stateless, using MCP SDK 1.32.1 and the versions negotiated by that SDK. Accepted work belongs to durable API services. Disconnecting or restarting MCP does not cancel it. `tools/list` is authorized and ordered by stable tool name. Discovery uses a 1 MiB response budget, reserving at least 1 KiB for the JSON-RPC envelope and counting the tools array, separators and any continuation cursor in the remaining bytes. It has no arbitrary tool-count cap. The current catalog fits in one result for clients that discover tools once; clients must follow `nextCursor` when a future catalog exceeds the byte budget. A single schema exceeding that limit fails explicitly. Results use `{ result: ... }` structured content (the exported `OpenPondMcpStructuredResult<T>` retains the public SDK result type). Learning discovery uses compact resource/operation identity envelopes instead of repeating the full polymorphic evidence schema on every tool; complete results are still validated by the full SDK schema and retained unchanged. Results retain the SDK's verified identities and evidence. Large results fail explicitly rather than truncating evidence; use a smaller supported page or the canonical Console resource. Mutations conservatively advertise `idempotentHint: false` unless their specific adapter marks a durable retry contract.

## Workflow coverage

| Group | Supported tools and authority |
| --- | --- |
| Connection | Fixed account/user ID, workspace ID and granted scopes; no workload is launched. |
| Projects | List/get/save/archive with revisions, owner scope and operation IDs. |
| Datasets | List/get/save/validate/publish/begin-version, exact versions, retained operation recovery, preparation grants/runs/actions/candidates and immutable taskset packages/catalog. |
| Graders | Released catalog, versions and usage; authoring drafts/checks/publication use the shared learning contracts. |
| Evals | Defaults, Harness source discovery/preparation, launch/list/status/result/diagnostics, compatible comparison, duplicate/cancel, scoring passes and shared comparison budgets. |
| Models | Configuration inventory/readiness/check/save, explicit initial learning creation, and portable source sync. |
| Ponder | Estimate/prepare/start/cancel, input artifact upload, durable jobs/status/recovery/graceful stop, bounded events/logs, outputs, evaluation tasks, acceptance snapshots and candidate review decisions. |
| Learning | Typed named resource publication, draft/check/review/intake/evidence/batch/grade/iteration commands, pinned reads and paginated inventory. Policy publication and Model initial learning require separate learning authority. Dataset preparation start/resume/release require both execute and publish authority because the approved finish policy can publish automatically. |
| Human review | Typed creation/assignment/submission/decision commands, inbox/snapshots/results and members. Attached execution cancellation requires both review and cancel scopes. |

App scopes are `app:read`, `app:write`, `app:execute`, `app:publish`, `app:cancel`, `app:review` and `app:learning`. They are separate from organization-action MCP scopes. Tool annotations describe effects and grant no authority. Publish, launch, candidate review and learning policy publication remain separate operations. Serving activation and general compute administration are not exposed.

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
| `openpond training hosted-evaluation-tasks/hosted-corrections/hosted-learning-inspect` | `training_evaluation_tasks`, `learning_correction_metrics`, policy list/inspection and task queue inspection. |
| Public post-training evaluation SDK | `training_post_evaluation_attach/get/start/retry/cancel`; evaluation never implicitly reruns training. |

## Boundaries and release gates

The package requires compatible public SDK learning-command and correction-metrics exports. Before an npm release, publish the required SDK contracts, set the minimum SDK dependency to their supported version, and verify a clean installation using published dependencies. The current `openpond-sdk@0.12.5` registry release does not contain all required exports.

The tool catalog excludes local filesystem access, shell execution, desktop-session management and account or infrastructure administration. Asset uploads accept the existing typed hash-verified upload/package contracts, never a path interpreted on the MCP host. Profiles/Skills/Harness authoring and published organization actions remain under their existing separate interfaces; released Harness evaluation targets are supported here.

Hosts must implement OAuth discovery, token refresh and revocation, and verify workspace isolation and client interoperability before offering a connection. Keep authorization checks and approved budgets in force for every operation.

Build and check the focused package:

```sh
node scripts/run-typescript.mjs tsc -p packages/mcp/tsconfig.json
node --test packages/mcp/test/protocol-boundary.test.mjs
npm pack ./packages/mcp --dry-run
```
