import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  largeRawPayload,
  largeArtifactRecord,
  largeSourceCheckPayload,
  largeWorkItemStatusResponse,
  sourceUploadMetadataStatusFixture,
  sourceCheckClassificationPayload,
  sandboxRecord,
  sandboxGitPatchExportRecord,
  sandboxRuntimeRecord,
  sandboxProjectRecord,
  sandboxAgentRecord,
  sandboxAgentRunRecord,
  sandboxAgentSourceDeployPlanRecord,
  sandboxAgentManifestSnapshotRecord,
  sandboxCommandRecord,
  sandboxProcessRecord,
  sandboxScheduleRecord,
  sandboxPricingRateCard,
  sandboxSecretRecord,
} from "./cli-sandbox-record-fixtures";

export const CLI_SECRET = "cli-secret-value-that-must-not-echo";
export const AGENT_SDK_PILOT_NAMES = [
  "blank-agent",
  "customer-reply-agent",
  "water-estimator-agent",
  "integration-heavy-agent",
] as const;

export {
  LARGE_RAW_MARKER,
  largeRawPayload,
  largeArtifactRecord,
  largeSourceCheckPayload,
  largeWorkItemStatusResponse,
  sourceUploadMetadataStatusFixture,
  sourceCheckClassificationPayload,
  sandboxRecord,
  sandboxGitPatchExportRecord,
  sandboxRuntimeRecord,
  sandboxProjectRecord,
  sandboxAgentRecord,
  sandboxAgentRunRecord,
  sandboxAgentSourceDeployPlanRecord,
  sandboxAgentManifestSnapshotRecord,
  sandboxCommandRecord,
  sandboxProcessRecord,
  sandboxScheduleRecord,
  sandboxPricingRateCard,
  sandboxSecretRecord,
} from "./cli-sandbox-record-fixtures";

export type CapturedRequest = {
  method: string;
  url: string;
  body: Record<string, unknown>;
  apiKey: string | null;
  prefer: string | null;
};

const CLI_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function withSandboxApi(
  requests: CapturedRequest[],
  callback: (sandboxApiUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "",
      body,
      apiKey: request.headers["openpond-api-key"]?.toString() ?? null,
      prefer: request.headers.prefer?.toString() ?? null,
    });

    if (request.url === "/v1/sandbox-secrets" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          secrets: [sandboxSecretRecord({ name: "FOO_API_KEY" })],
        })
      );
      return;
    }

    if (request.url === "/v1/sandboxes/pricing" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pricing: sandboxPricingRateCard() }));
      return;
    }

    if (
      request.url === "/v1/sandboxes/costs?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          costs: {
            teamId: "team_test",
            ownerUserId: "user_test",
            pricing: sandboxPricingRateCard(),
            summary: {
              sandboxCount: 3,
              runningCount: 1,
              stoppedCount: 2,
              archivedCount: 0,
              receiptCount: 1,
              totalUsd: "0.000042",
              totalDurationSeconds: 42,
              activeReservedUsd: "0.050000",
              activeRemainingBudgetUsd: "0.049958",
              activeRunnerSlots: 1,
            },
            lineItems: [
              {
                label: "vCPU",
                unit: "vCPU-second",
                quantity: 1,
                amountUsd: "0.000042",
              },
            ],
            sandboxes: [
              {
                sandboxId: "sandbox_test",
                state: "running",
                repo: null,
                createdAt: "2026-05-20T00:00:00.000Z",
                updatedAt: "2026-05-20T00:00:01.000Z",
                receiptCount: 1,
                totalUsd: "0.000042",
                durationSeconds: 42,
                latestReceiptRef: "receipt_test",
                latestReceiptAt: "2026-05-20T00:00:01.000Z",
              },
            ],
            recentReceipts: [],
            generatedAt: "2026-05-20T00:00:01.000Z",
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/projects?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects: [sandboxProjectRecord()] }));
      return;
    }

    if (request.url === "/v1/projects" && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          project: sandboxProjectRecord({
            name: String(body.name ?? "Demo Project"),
            sourceType: String(body.sourceType ?? "manual"),
            gitOwner: typeof body.gitOwner === "string" ? body.gitOwner : null,
            gitRepo: typeof body.gitRepo === "string" ? body.gitRepo : null,
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/projects/project_test?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ project: sandboxProjectRecord() }));
      return;
    }

    if (
      request.url === "/v1/projects/project_test?teamId=team_test" &&
      request.method === "PATCH"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          project: sandboxProjectRecord({
            description:
              typeof body.description === "string" ? body.description : null,
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/projects/project_test/source?teamId=team_test" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          project: sandboxProjectRecord({
            sourceType: "internal_repo",
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/projects/project_test?teamId=team_test" &&
      request.method === "DELETE"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          project: sandboxProjectRecord({ status: "archived" }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agents: [sandboxAgentRecord()] }));
      return;
    }

    if (request.url === "/v1/agents" && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          agent: sandboxAgentRecord({
            name: String(body.name ?? "Daily Report"),
            selectedEntrypoint:
              typeof body.selectedEntrypoint === "object" &&
              body.selectedEntrypoint
                ? (body.selectedEntrypoint as Record<string, unknown>)
                : undefined,
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents/agent_test?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agent: sandboxAgentRecord() }));
      return;
    }

    if (
      request.url === "/v1/agents/agent_test?teamId=team_test" &&
      request.method === "PATCH"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      const runtimeSource =
        body.runtimeSource &&
        typeof body.runtimeSource === "object" &&
        !Array.isArray(body.runtimeSource)
          ? (body.runtimeSource as Record<string, unknown>)
          : undefined;
      response.end(
        JSON.stringify({
          agent: {
            ...sandboxAgentRecord({
              triggerType:
                body.triggerType === "background" ? "background" : "manual",
            }),
            ...(runtimeSource ? { runtimeSource } : {}),
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents/agent_test?teamId=team_test" &&
      request.method === "DELETE"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          agent: sandboxAgentRecord({ status: "archived" }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents/agent_test/run" &&
      request.method === "POST"
    ) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          agent: sandboxAgentRecord(),
          run: sandboxAgentRunRecord(body),
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/agents/agent_test/source/deploy-plan?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ deployPlan: sandboxAgentSourceDeployPlanRecord() })
      );
      return;
    }

    if (
      request.url ===
        "/v1/agents/agent_test/source/manifest-snapshots?teamId=team_test&limit=2" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          manifestSnapshots: [sandboxAgentManifestSnapshotRecord()],
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents/agent_test/source/checks?teamId=team_test" &&
      request.method === "POST"
    ) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: "work_item_test",
            projectId: "project_test",
            assignedAgentId: "agent_test",
          },
          createdEditWorkItem: true,
          activity: { id: "activity_checks", type: "action_requested" },
          deployPlan: sandboxAgentSourceDeployPlanRecord(),
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents/agent_test/source/publish?teamId=team_test" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          agent: sandboxAgentRecord(),
          projection: { status: "ready" },
          activeManifestSnapshot: {
            id: "snapshot_test",
            source: "project_manifest",
            sourceRef: "master",
            sourceCommitSha: "sha_test",
            manifestHash: "hash_test",
            manifestPath: "openpond.yaml",
            manifestSyncedAt: "2026-05-20T00:00:00.000Z",
            buildStatus: "passed",
            validationStatus: "passed",
            evalStatus: "passed",
            publishedAt: "2026-05-20T00:00:00.000Z",
          },
          publishedAt: "2026-05-20T00:00:00.000Z",
        })
      );
      return;
    }

    if (
      request.url === "/v1/agents/agent_test/edit-work-item?teamId=team_test" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: "work_item_test",
            projectId: "project_test",
            assignedAgentId: "agent_test",
            status: "needs_review",
          },
          created: true,
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_test?teamId=team_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: "work_item_test",
            projectId: "project_test",
            assignedAgentId: "agent_test",
            status: "needs_review",
            latestTaskRunId: "task_run_test",
          },
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/work-items/work_item_large/status?teamId=team_test&limit=2&includeArchived=true" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(largeWorkItemStatusResponse()));
      return;
    }

    const classificationStatusMatch = request.url?.match(
      /^\/v1\/work-items\/(work_item_(?:dependency_install_failure|missing_sdk_binary|unresolved_file_dependency|missing_artifact_directory|missing_source_upload_metadata|stale_source_upload_metadata|invalid_inspect_json|validation_failure|eval_failure|publish_blocked))\/status\?teamId=team_test&limit=2&includeArchived=true$/
    );
    if (classificationStatusMatch && request.method === "GET") {
      const workItemId = classificationStatusMatch[1] ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: workItemId,
            projectId: "project_test",
            assignedAgentId: "agent_test",
            status: "failed",
            latestTaskRunId: `${workItemId}_task`,
            latestRuntimeId: `${workItemId}_runtime`,
            latestSandboxId: `${workItemId}_sandbox`,
          },
          activity: [
            {
              id: `${workItemId}_activity`,
              type: "task_event",
              payload: sourceCheckClassificationPayload(workItemId),
            },
          ],
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/work-items/work_item_test/status?teamId=team_test&limit=2&includeArchived=true" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: "work_item_test",
            projectId: "project_test",
            assignedAgentId: "agent_test",
            status: "needs_review",
            latestTaskRunId: "task_run_test",
            latestRuntimeId: "runtime_test",
            latestSandboxId: "sandbox_test",
          },
          activity: [
            {
              id: "activity_checks",
              type: "action_requested",
              payload: {
                checkKind: "validate",
                deployPlanStatus: "needs_validation",
                canDeploy: false,
                blockedReasons: ["source_commit_sha_missing"],
              sourceMaterialization: {
                status: "completed",
                sourceCommitSha: "source_sha_test",
                },
                sourceUploadMetadata: sourceUploadMetadataStatusFixture(),
                setup: {
                  status: "completed",
                  passed: true,
                  commands: ["pnpm install --offline"],
                  expectedBinaryPath: "node_modules/.bin/openpond-agent",
                },
                policyDiscovery: {
                  status: "completed",
                  command: "openpond agent inspect --json",
                  exitCode: 0,
                  durationMs: 12,
                  requiredChecks: [
                    "openpond agent validate",
                    "openpond agent eval",
                  ],
                },
                discoveredRequiredChecks: [
                  "openpond agent validate",
                  "openpond agent eval",
                ],
                checkRuns: [
                  {
                    commandId: "validation-01",
                    command: "openpond agent validate",
                    status: "passed",
                    passed: true,
                    exitCode: 0,
                    durationMs: 10,
                  },
                ],
                validation: { status: "passed", passed: true },
                traceArtifactRef: "artifacts/openpond-trace.jsonl",
                evalResultArtifactRef:
                  "artifacts/openpond-eval-results.json",
                validatorArtifactRefs: ["artifacts/validator-report.json"],
                patchArtifactRef:
                  "openpond://coding-task-runs/task_run_test/patch",
                finalResultState: "completed",
              },
            },
          ],
          sourceCheckStatus: {
            workItemId: "work_item_test",
            workItemStatus: "needs_review",
            latestTaskRunId: "task_run_test",
            latestRuntimeId: "runtime_test",
            latestSandboxId: "sandbox_test",
            sourceMaterialization: {
              status: "completed",
              sourceCommitSha: "source_sha_test",
            },
            sourceUploadMetadata: sourceUploadMetadataStatusFixture(),
            setup: {
              status: "completed",
              passed: true,
              commands: ["pnpm install --offline"],
              expectedBinaryPath: "node_modules/.bin/openpond-agent",
            },
            policyDiscovery: {
              status: "completed",
              command: "openpond agent inspect --json",
              exitCode: 0,
              durationMs: 12,
              requiredChecks: [
                "openpond agent validate",
                "openpond agent eval",
              ],
            },
            discoveredRequiredChecks: [
              "openpond agent validate",
              "openpond agent eval",
            ],
            checkRuns: [
              {
                commandId: "validation-01",
                command: "openpond agent validate",
                status: "passed",
                passed: true,
                exitCode: 0,
                durationMs: 10,
              },
            ],
            validation: { status: "passed", passed: true },
            requestedCheckKind: "validate",
            deployPlan: {
              status: "needs_validation",
              canDeploy: false,
              blockedReasons: ["source_commit_sha_missing"],
            },
            traceArtifactRefs: ["artifacts/openpond-trace.jsonl"],
            evalResultArtifactRefs: [
              "artifacts/openpond-eval-results.json",
            ],
            validatorArtifactRefs: ["artifacts/validator-report.json"],
            patchArtifactRef:
              "openpond://coding-task-runs/task_run_test/patch",
            finalResultState: "completed",
            publishBlockers: ["source_commit_sha_missing"],
          },
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/work-items/work_item_failed_setup/status?teamId=team_test&limit=2&includeArchived=true" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: "work_item_failed_setup",
            projectId: "project_test",
            assignedAgentId: "agent_test",
            status: "failed",
            latestTaskRunId: "task_run_failed_setup",
            latestRuntimeId: "runtime_failed_setup",
            latestSandboxId: "sandbox_failed_setup",
          },
          activity: [
            {
              id: "activity_failed_setup",
              type: "task_event",
              payload: {
                setup: {
                  status: "failed",
                  message: "yaml@^2.9.0 failed to resolve",
                  command: "pnpm install --offline",
                  exitCode: 1,
                  commands: ["pnpm install --offline"],
                  expectedBinaryPath: "node_modules/.bin/openpond-agent",
                  dependencyPackages: [
                    {
                      packageName: "yaml",
                      source: "npm",
                      versionSpec: "^2.9.0",
                      path: ".openpond/vendor/npm/yaml.tgz",
                      sha256: "sha_yaml",
                      sizeBytes: 112086,
                    },
                  ],
                },
              },
            },
          ],
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_test/chat" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          userMessage: { id: "message_user", role: "user" },
          assistantMessage: { id: "message_assistant", role: "assistant" },
          activity: { id: "activity_chat", type: "message_created" },
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/work-items/work_item_test/activity?teamId=team_test&limit=2" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          activity: [
            {
              id: "activity_checks",
              type: "action_requested",
              payload: {
                checkKind: "validate",
                deployPlanStatus: "needs_validation",
                canDeploy: false,
                blockedReasons: ["source_commit_sha_missing"],
                traceArtifactRef: "artifacts/openpond-trace.jsonl",
                evalResultArtifactRef:
                  "artifacts/openpond-eval-results.json",
              },
            },
          ],
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/work-items/work_item_large/activity?teamId=team_test&limit=2" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          activity: [
            {
              id: "activity_large",
              type: "task_event",
              payload: largeSourceCheckPayload(),
              rawSandboxProcessOutput: largeRawPayload(),
            },
          ],
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_test/handle-background" &&
      request.method === "POST"
    ) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: { id: "work_item_test", status: "running" },
          taskRun: { id: "task_run_test" },
          link: { id: "link_test" },
          activity: { id: "activity_background", type: "task_started" },
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_large/handle-background" &&
      request.method === "POST"
    ) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          workItem: {
            id: "work_item_large",
            status: "running",
            metadata: { rawTaskPayload: largeRawPayload() },
          },
          taskRun: {
            id: "task_run_large",
            rawLog: largeRawPayload(),
          },
          link: { id: "link_large", rawRequest: largeRawPayload() },
          activity: {
            id: "activity_large_background",
            type: "task_started",
            payload: largeSourceCheckPayload(),
            rawEvents: largeRawPayload(),
          },
          rawTaskPayload: largeRawPayload(),
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_test/result/checkpoint" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          artifact: {
            id: "artifact_checkpoint",
            kind: "checkpoint",
            ref: body.ref,
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_large/result/checkpoint" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          artifact: largeArtifactRecord("artifact_large_checkpoint", "checkpoint", body.ref),
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_test/result/commit" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          artifact: {
            id: "artifact_commit",
            kind: "commit",
            ref: body.ref,
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_large/result/commit" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          artifact: largeArtifactRecord("artifact_large_commit", "commit", body.ref),
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_test/result/pr" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          artifact: {
            id: "artifact_pr",
            kind: "pr",
            ref: body.ref,
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/work-items/work_item_large/result/pr" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          artifact: largeArtifactRecord("artifact_large_pr", "pr", body.ref),
        })
      );
      return;
    }

    if (request.url === "/v1/runtimes" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ runtimes: [sandboxRuntimeRecord()] }));
      return;
    }

    if (
      request.url === "/v1/runtimes/workspace_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ runtime: sandboxRuntimeRecord() }));
      return;
    }

    if (
      request.url === "/v1/runtimes/workspace_test/events" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          events: [
            {
              id: "event_test",
              runtimeId: "workspace_test",
              sequence: 1,
              type: "workflow.waiting_for_user",
              summary: "waiting",
              actorType: "agent",
              actorId: "agent_test",
              payload: {},
              commitSha: null,
              snapshotId: null,
              logRef: null,
              artifactRefs: [],
              eventHash: "hash_test",
              previousEventHash: null,
              createdAt: "2026-05-20T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        })
      );
      return;
    }

    if (
      request.url === "/v1/runtimes/workspace_test/events" &&
      request.method === "POST"
    ) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          runtime: sandboxRuntimeRecord(),
          event: {
            id: "event_written",
            runtimeId: "workspace_test",
            sequence: 2,
            type: body.type,
            summary: body.summary ?? null,
            payload: body.payload ?? {},
            lifecycleHint: body.lifecycleHint ?? null,
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/runtimes/workspace_test/status" &&
      request.method === "PATCH"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          runtime: {
            ...sandboxRuntimeRecord(),
            status: body.status,
          },
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/runtimes/workspace_test/preserve-source?teamId=team_test" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          runtime: {
            ...sandboxRuntimeRecord(),
            currentSha: "feed123",
          },
          preservedSha: "feed123",
          preserved: true,
          patch: sandboxGitPatchExportRecord(body),
        })
      );
      return;
    }

    if (request.url === "/v1/sandbox-secrets" && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          secret: sandboxSecretRecord({
            name: String(body.name ?? "FOO_API_KEY"),
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandbox-secrets/secret_test/attach" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          secret: sandboxSecretRecord({
            name: "FOO_API_KEY",
            attachments: [
              {
                envName: body.envName,
                targetType: body.targetType,
                targetId: body.targetId,
                attachedAt: "2026-05-20T00:00:00.000Z",
                detachedAt: null,
              },
            ],
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandbox-secrets/secret_test/rotate" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          secret: sandboxSecretRecord({
            name: "FOO_API_KEY",
            secretRef: "openpond://secret/team_test/secret_test#v2",
            currentVersion: 2,
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandbox-secrets/secret_test/revoke" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          secret: sandboxSecretRecord({
            name: "FOO_API_KEY",
            status: "revoked",
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandbox-secrets/secret_test" &&
      request.method === "DELETE"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          secret: sandboxSecretRecord({
            name: "FOO_API_KEY",
            status: "deleted",
          }),
        })
      );
      return;
    }

    if (request.url === "/v1/runtimes" && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          runtime: sandboxRuntimeRecord({
            projectId:
              typeof body.projectId === "string" ? body.projectId : null,
            agentId: typeof body.agentId === "string" ? body.agentId : null,
          }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/runtimes/workspace_test/sandbox" &&
      request.method === "POST"
    ) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          runtime: sandboxRuntimeRecord({
            projectId:
              typeof body.projectId === "string" ? body.projectId : null,
            agentId: typeof body.agentId === "string" ? body.agentId : null,
          }),
          sandbox: sandboxRecord({ runtimeId: "workspace_test" }),
        })
      );
      return;
    }

    if (request.url === "/v1/sandboxes" && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord({ runtimeId: null }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/sandbox_test" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord({ runtimeId: "workspace_test" }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/sandbox_test/start" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord({ runtimeId: "workspace_test" }),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/sandbox_test/exec" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord(),
          command: sandboxCommandRecord(String(body.command ?? "true")),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/sandbox_test/git/export-patch" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord({ runtimeId: "workspace_test" }),
          patch: sandboxGitPatchExportRecord(body),
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/sandboxes/sandbox_test/stop?failOnUnpreservedChanges=true" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord({ runtimeId: "workspace_test" }),
          receipt: {
            ref: "sandbox_stop_receipt_test",
            status: "accepted",
          },
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/sandboxes/sandbox_test?failOnUnpreservedChanges=true" &&
      request.method === "DELETE"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: {
            ...sandboxRecord({ runtimeId: "workspace_test" }),
            state: "deleted",
            deletedAt: "2026-05-20T00:01:00.000Z",
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/sandbox_test/files" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord(),
          file: {
            path: body.path,
            sizeBytes: String(body.contentsBase64 ?? "").length,
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
        })
      );
      return;
    }

    if (
      request.url ===
        "/v1/sandboxes/sandbox_test/files?path=src%2Fmessage.txt" &&
      request.method === "GET"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord(),
          file: {
            path: "src/message.txt",
            contentsBase64: Buffer.from(
              "hello from runtime files",
              "utf-8"
            ).toString("base64"),
            sizeBytes: "24",
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/sandbox_test/processes" &&
      request.method === "POST"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sandbox: sandboxRecord(),
          process: sandboxProcessRecord(String(body.command ?? "echo ok")),
        })
      );
      return;
    }

    if (
      request.url === "/v1/sandboxes/schedules" &&
      request.method === "POST"
    ) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          schedule: sandboxScheduleRecord(body),
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind to a TCP port");
  }
  try {
    await callback(`http://127.0.0.1:${address.port}/v1/sandboxes`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

export async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

export function runCli(
  args: string[],
  stdin = "",
  options: { cwd?: string } = {}
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        createRequire(import.meta.url).resolve("tsx/cli"),
        path.join(CLI_PACKAGE_ROOT, "src/cli/main.ts"),
        ...args,
      ],
      {
        cwd: options.cwd ?? CLI_PACKAGE_ROOT,
        env: {
          ...process.env,
          OPENPOND_API_KEY: "opk_test_cli",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export function runTestCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: Record<string, string | undefined> } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env:
        options.env === undefined
          ? process.env
          : {
              ...process.env,
              ...options.env,
            },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed: ${[
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join("\n")}`
        )
      );
    });
  });
}

export function runTestCommandWithOutput(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed: ${stderr}`));
    });
  });
}

export async function writeSourceUploadEntriesToDirectory(
  entries: Array<{ path: string; contentsBase64?: string }>,
  targetDir: string
): Promise<void> {
  const targetRoot = path.resolve(targetDir);
  for (const entry of entries) {
    const outputPath = path.resolve(targetRoot, entry.path);
    if (!outputPath.startsWith(`${targetRoot}${path.sep}`)) {
      throw new Error(`refusing unsafe upload entry path ${entry.path}`);
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      Buffer.from(entry.contentsBase64 ?? "", "base64")
    );
  }
}

export async function runDependencySetupFromUploadMetadata(
  materializedDir: string
): Promise<void> {
  const metadataPath = path.join(
    materializedDir,
    ".openpond",
    "source-upload-metadata.json"
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    dependencySetup?: { commands?: string[]; installCommand?: string };
  };
  const command =
    metadata.dependencySetup?.commands?.find((entry) => entry.trim()) ??
    metadata.dependencySetup?.installCommand;
  if (!command) {
    throw new Error("source-upload metadata did not declare dependency setup");
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const [commandName, ...args] = parts;
  if (!commandName) {
    throw new Error("source-upload metadata dependency setup is empty");
  }
  const setupArgs = [...args];
  let setupEnv: Record<string, string | undefined> | undefined;
  const pnpmStoreDir = await mkdtemp(
    path.join(os.tmpdir(), "openpond-agent-sdk-empty-pnpm-store-")
  );
  try {
    if (commandName === "pnpm" && setupArgs[0] === "install") {
      setupArgs.push(
        "--store-dir",
        pnpmStoreDir
      );
      setupEnv = { HOME: pnpmStoreDir };
    }
    await runTestCommand(commandName, setupArgs, materializedDir, {
      env: setupEnv,
    });
  } finally {
    await rm(pnpmStoreDir, { recursive: true, force: true });
  }
}

export function resolveTestAgentSdkRoot(): string {
  const configured = process.env.OPENPOND_AGENT_SDK_PATH;
  const candidates = configured
    ? [path.resolve(configured)]
    : [
        path.resolve(process.cwd(), "../../packages/agent-sdk"),
        path.resolve(process.cwd(), "packages/agent-sdk"),
        path.resolve(process.cwd(), "../openpond-agent-sdk"),
      ];
  const candidate = candidates.find((pathCandidate) => existsSync(path.join(pathCandidate, "package.json")));
  if (!candidate) {
    throw new Error("Could not resolve openpond-agent-sdk test package root.");
  }
  const packageJsonPath = path.join(candidate, "package.json");
  const packageJson = JSON.parse(readFileSyncForTest(packageJsonPath)) as {
    name?: string;
  };
  expect(packageJson.name).toBe("openpond-agent-sdk");
  return candidate;
}

export async function rewriteAgentSdkDependencyForTest(
  projectDir: string,
  dependency: string
): Promise<void> {
  const packageJsonPath = path.join(projectDir, "package.json");
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8")
  ) as {
    dependencies?: Record<string, string>;
  };
  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    "openpond-agent-sdk": dependency,
  };
  await writeFile(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8"
  );
}

export function readFileSyncForTest(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export async function writeAgentSdkUploadFixture(projectDir: string): Promise<void> {
  await mkdir(path.join(projectDir, "agent"), { recursive: true });
  await mkdir(path.join(projectDir, ".openpond", "local-sdk-source", "dist"), {
    recursive: true,
  });
  await mkdir(path.join(projectDir, ".openpond", "fixture-runtime-dep"), {
    recursive: true,
  });
  await mkdir(path.join(projectDir, "node_modules", ".bin"), {
    recursive: true,
  });
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify(
      {
        type: "module",
        dependencies: {
          "openpond-agent-sdk": "file:.openpond/local-sdk-source",
        },
        scripts: {
          "agent:inspect": "openpond-agent inspect --json",
          "agent:build": "openpond-agent build",
          "agent:validate": "openpond-agent validate",
          "agent:eval": "openpond-agent eval",
        },
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(projectDir, ".openpond", "local-sdk-source", "package.json"),
    JSON.stringify(
      {
        name: "openpond-agent-sdk",
        version: "0.0.0-test",
        type: "commonjs",
        files: ["dist"],
        dependencies: {
          "fixture-runtime-dep": "file:../fixture-runtime-dep",
        },
        bin: {
          "openpond-agent": "./dist/cli.js",
        },
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(projectDir, ".openpond", "fixture-runtime-dep", "package.json"),
    JSON.stringify(
      {
        name: "fixture-runtime-dep",
        version: "0.0.0-test",
        type: "module",
        main: "./index.js",
        files: ["index.js"],
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(projectDir, ".openpond", "fixture-runtime-dep", "index.js"),
    "export const fixtureRuntimeDep = true;\n",
    "utf8"
  );
  await writeFile(
    path.join(projectDir, ".openpond", "local-sdk-source", "dist", "cli.js"),
    agentSdkUploadFixtureBin(),
    "utf8"
  );
  await writeFile(
    path.join(projectDir, "agent", "agent.ts"),
    "export default { name: 'upload-fixture' };\n",
    "utf8"
  );
  const binPath = path.join(projectDir, "node_modules", ".bin", "openpond-agent");
  await writeFile(binPath, agentSdkUploadFixtureBin(), "utf8");
  await chmod(binPath, 0o755);
}

export function agentSdkUploadFixtureBin(): string {
  return [
    "#!/usr/bin/env node",
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    "const path = require('node:path');",
    "const [command, ...args] = process.argv.slice(2);",
    "const cwdIndex = args.indexOf('--cwd');",
    "const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();",
    "const artifactDir = path.join(cwd, '.openpond');",
    "mkdirSync(artifactDir, { recursive: true });",
    "if (command === 'inspect') {",
    "  const inspect = { name: 'sdk-upload-fixture', editable: { enabled: true, requiredChecks: [{ name: 'validate', command: 'pnpm run agent:validate' }] } };",
    "  writeFileSync(path.join(artifactDir, 'agent-inspect.json'), JSON.stringify(inspect, null, 2));",
    "  console.log(JSON.stringify(inspect));",
    "  process.exit(0);",
    "}",
    "if (command === 'build') {",
    "  const manifest = ['schemaVersion: 1', 'schema: openpond.runtime.manifest.v1', 'name: sdk-upload-fixture', 'version: 0.1.0', 'useCase: sdk-upload-fixture', 'description: SDK upload fixture.', 'runtime:', '  base: node-bun-workspace', 'setup:', '  commands: []', 'validation:', '  commands:', '    - \"true\"', 'start:', '  command: openpond-agent run chat', '  ports: []', 'actions:', '  - name: chat', '    command: openpond-agent run chat', '    ports: []', 'services: []', 'schedules: []', 'volumes: []', 'integrations:', '  requiredLeases: []', 'permissions: {}', 'inputs:', '  schema:', '    type: object', '  env: []', 'artifacts:', '  paths: []', 'network:', '  egress: restricted', ''].join('\\n');",
    "  writeFileSync(path.join(artifactDir, 'openpond-manifest.preview.yaml'), manifest);",
    "  writeFileSync(path.join(artifactDir, 'agent-inspect.json'), JSON.stringify({ editable: { enabled: true } }, null, 2));",
    "  writeFileSync(path.join(artifactDir, 'agent-manifest.json'), JSON.stringify({ schemaVersion: 1 }, null, 2));",
    "  writeFileSync(path.join(artifactDir, 'action-registry.json'), JSON.stringify({ actions: [{ id: 'chat', name: 'chat', setupRequirements: [{ kind: 'env', name: 'UPLOAD_FIXTURE_TOKEN', required: true, secret: true, status: 'setup_required' }] }] }, null, 2));",
    "  writeFileSync(path.join(artifactDir, 'runtime-bridge.mjs'), 'export const actionRegistry = {};\\n');",
    "  writeFileSync(path.join(artifactDir, 'validator-report.md'), '# ok\\n');",
    "  process.exit(0);",
    "}",
    "if (command === 'validate') process.exit(0);",
    "if (command === 'eval') {",
    "  writeFileSync(path.join(artifactDir, 'eval-results.json'), JSON.stringify({ ok: true }, null, 2));",
    "  process.exit(0);",
    "}",
    "console.error(`unexpected command ${command}`);",
    "process.exit(1);",
    "",
  ].join("\n");
}
