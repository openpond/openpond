import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_SECRET = "cli-secret-value-that-must-not-echo";
export const LARGE_RAW_MARKER = "raw-large-payload-that-must-not-echo";
export const AGENT_SDK_PILOT_NAMES = [
  "blank-agent",
  "customer-reply-agent",
  "water-estimator-agent",
  "integration-heavy-agent",
] as const;

export type CapturedRequest = {
  method: string;
  url: string;
  body: Record<string, unknown>;
  apiKey: string | null;
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
                  commands: ["bun install --offline"],
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
              commands: ["bun install --offline"],
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
                  command: "bun install --offline",
                  exitCode: 1,
                  commands: ["bun install --offline"],
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
      [path.join(CLI_PACKAGE_ROOT, "src/cli/main.ts"), ...args],
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
  const bunCacheDir = await mkdtemp(
    path.join(os.tmpdir(), "openpond-agent-sdk-empty-bun-cache-")
  );
  try {
    if (commandName === "bun" && setupArgs[0] === "install") {
      setupArgs.push(
        "--cache-dir",
        bunCacheDir,
        "--no-cache",
        "--registry",
        "http://127.0.0.1:9"
      );
      setupEnv = { HOME: bunCacheDir };
    }
    await runTestCommand(commandName, setupArgs, materializedDir, {
      env: setupEnv,
    });
  } finally {
    await rm(bunCacheDir, { recursive: true, force: true });
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
    "  const inspect = { name: 'sdk-upload-fixture', editable: { enabled: true, requiredChecks: [{ name: 'validate', command: 'bun run agent:validate' }] } };",
    "  writeFileSync(path.join(artifactDir, 'agent-inspect.json'), JSON.stringify(inspect, null, 2));",
    "  console.log(JSON.stringify(inspect));",
    "  process.exit(0);",
    "}",
    "if (command === 'build') {",
    "  const manifest = ['schemaVersion: 1', 'schema: openpond.runtime.manifest.v1', 'name: sdk-upload-fixture', 'version: 0.1.0', 'useCase: sdk-upload-fixture', 'description: SDK upload fixture.', 'runtime:', '  base: node-bun-workspace', 'setup:', '  commands: []', 'validation:', '  commands:', '    - \"true\"', 'start:', '  command: openpond-agent run chat', '  ports: []', 'actions:', '  - name: chat', '    command: openpond-agent run chat', '    ports: []', 'services: []', 'schedules: []', 'volumes: []', 'integrations:', '  requiredLeases: []', 'permissions: {}', 'inputs:', '  schema:', '    type: object', '  env: []', 'artifacts:', '  paths: []', 'network:', '  egress: restricted', ''].join('\\n');",
    "  writeFileSync(path.join(artifactDir, 'openpond-manifest.preview.yaml'), manifest);",
    "  writeFileSync(path.join(artifactDir, 'agent-inspect.json'), JSON.stringify({ editable: { enabled: true } }, null, 2));",
    "  writeFileSync(path.join(artifactDir, 'agent-manifest.json'), JSON.stringify({ schemaVersion: 1 }, null, 2));",
    "  writeFileSync(path.join(artifactDir, 'action-registry.json'), JSON.stringify({ actions: [{ name: 'chat' }] }, null, 2));",
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

export function largeRawPayload(): string {
  return `${LARGE_RAW_MARKER}:`.repeat(10_000);
}

export function largeArtifactRecord(
  id: string,
  kind: string,
  ref: unknown
): Record<string, unknown> {
  return {
    id,
    kind,
    ref,
    createdAt: "2026-05-20T00:00:00.000Z",
    metadata: {
      rawPatch: largeRawPayload(),
    },
    rawDiff: largeRawPayload(),
  };
}

export function largeSourceCheckPayload(): Record<string, unknown> {
  return {
    checkKind: "all",
    deployPlanStatus: "needs_validation",
    canDeploy: false,
    blockedReasons: ["source_commit_sha_missing"],
    sourceMaterialization: {
      status: "completed",
      sourceCommitSha: "source_sha_large",
      rawCheckoutLog: largeRawPayload(),
    },
    sourceUploadMetadata: {
      ...sourceUploadMetadataStatusFixture(),
      rawSetupOutput: largeRawPayload(),
    },
    setup: {
      status: "completed",
      passed: true,
      commands: ["bun install --offline"],
      expectedBinaryPath: "node_modules/.bin/openpond-agent",
      rawInstallLog: largeRawPayload(),
    },
    policyDiscovery: {
      status: "completed",
      command: "openpond agent inspect --json",
      exitCode: 0,
      durationMs: 12,
      requiredChecks: ["openpond agent validate", "openpond agent eval"],
      rawStdout: largeRawPayload(),
    },
    discoveredRequiredChecks: [
      "openpond agent validate",
      "openpond agent eval",
    ],
    checkRuns: [
      {
        commandId: "validation-large",
        command: "openpond agent validate",
        status: "passed",
        passed: true,
        exitCode: 0,
        rawStderr: largeRawPayload(),
      },
    ],
    validation: {
      status: "passed",
      passed: true,
      rawValidatorOutput: largeRawPayload(),
    },
    eval: {
      status: "passed",
      passed: true,
      rawEvalResultsJson: largeRawPayload(),
    },
    traceArtifactRef: "artifacts/trace-large.jsonl",
    traceArtifactRefs: ["artifacts/trace-large.jsonl"],
    evalResultArtifactRef: "artifacts/eval-large.json",
    evalResultArtifactRefs: ["artifacts/eval-large.json"],
    validatorArtifactRefs: ["artifacts/validator-large.json"],
    patchArtifactRef: "openpond://coding-task-runs/task_run_large/patch",
    draftSourceRef: "draft/source-large",
    finalResultState: "completed",
    publishBlockers: ["source_commit_sha_missing"],
    rawSandboxProcessOutput: largeRawPayload(),
  };
}

export function largeWorkItemStatusResponse(): Record<string, unknown> {
  return {
    workItem: {
      id: "work_item_large",
      projectId: "project_test",
      assignedAgentId: "agent_test",
      status: "needs_review",
      latestTaskRunId: "task_run_large",
      latestRuntimeId: "runtime_large",
      latestSandboxId: "sandbox_large",
      metadata: {
        rawTaskPayload: largeRawPayload(),
      },
    },
    activity: [
      {
        id: "activity_large",
        type: "task_event",
        payload: largeSourceCheckPayload(),
        rawEvents: largeRawPayload(),
      },
    ],
    sourceCheckStatus: {
      workItemId: "work_item_large",
      workItemStatus: "needs_review",
      latestTaskRunId: "task_run_large",
      latestRuntimeId: "runtime_large",
      latestSandboxId: "sandbox_large",
      ...largeSourceCheckPayload(),
      requestedCheckKind: "all",
      deployPlan: {
        status: "needs_validation",
        canDeploy: false,
        blockedReasons: ["source_commit_sha_missing"],
        rawPlan: largeRawPayload(),
      },
      rawStatusPayload: largeRawPayload(),
    },
    rawResponsePayload: largeRawPayload(),
  };
}

export function sourceUploadMetadataStatusFixture(): Record<string, unknown> {
  return {
    schema: "openpond.agent.source_upload.v1",
    sourceTreeMode: "typescript_agent_sdk",
    packageManager: "bun",
    commands: {
      inspect: "bun run agent:inspect",
      build: "bun run agent:build",
      validate: "bun run agent:validate",
      eval: "bun run agent:eval",
    },
    generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
    synthesizedOpenPondYaml: true,
    openPondYamlMode: "synthesized",
    uploadMetadataPath: ".openpond/source-upload-metadata.json",
    uploadMetadataHash: {
      sha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sizeBytes: 2816,
    },
    artifactHashes: {
      ".openpond/openpond-manifest.preview.yaml": {
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sizeBytes: 567,
      },
      ".openpond/agent-manifest.json": {
        sha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        sizeBytes: 1024,
      },
      "openpond.yaml": {
        sha256:
          "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        sizeBytes: 530,
      },
    },
    dependencySetup: {
      required: true,
      installCommand: "bun install --offline",
      commands: ["bun install --offline"],
      packageJsonPath: "package.json",
      expectedBinaryPath: "node_modules/.bin/openpond-agent",
      generatedArtifactDirectory: ".openpond",
      sdkPackage: {
        packageName: "openpond-agent-sdk",
        source: "uploaded_tarball",
        path: ".openpond/vendor/openpond-agent-sdk.tgz",
        sha256:
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sizeBytes: 52319,
      },
      dependencyPackages: [
        {
          packageName: "yaml",
          source: "npm_dependency_tarball",
          versionSpec: "^2.9.0",
          path: ".openpond/vendor/npm/yaml.tgz",
          sha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          sizeBytes: 112086,
        },
        {
          packageName: "zod",
          source: "npm_dependency_tarball",
          versionSpec: "^4.1.11",
          path: ".openpond/vendor/npm/zod.tgz",
          sha256:
            "1111111111111111111111111111111111111111111111111111111111111111",
          sizeBytes: 759588,
        },
      ],
    },
    redactedSetupOutputRefs: [
      "openpond://coding-task-runs/task_run_test/setup-output",
    ],
  };
}

export function sourceCheckClassificationPayload(
  workItemId: string
): Record<string, unknown> {
  if (workItemId === "work_item_dependency_install_failure") {
    return {
      sourceUploadMetadata: sourceUploadMetadataStatusFixture(),
      setup: {
        status: "failed",
        message: "dependency install failed",
        command: "bun install --offline",
        exitCode: 1,
        commands: ["bun install --offline"],
        expectedBinaryPath: "node_modules/.bin/openpond-agent",
        dependencyPackages: [
          {
            packageName: "yaml",
            source: "npm_dependency_tarball",
            versionSpec: "^2.9.0",
            path: ".openpond/vendor/npm/yaml.tgz",
            sha256: "sha_yaml",
            sizeBytes: 112086,
          },
        ],
      },
    };
  }
  if (workItemId === "work_item_missing_sdk_binary") {
    return {
      policyDiscovery: {
        status: "failed",
        message: "missing node_modules/.bin/openpond-agent",
        command: "bun run agent:inspect",
        exitCode: 127,
      },
    };
  }
  if (workItemId === "work_item_unresolved_file_dependency") {
    return {
      setup: {
        status: "failed",
        message: "unresolved local file dependency",
        command: "bun install --offline",
        exitCode: 1,
        commands: ["bun install --offline"],
        expectedBinaryPath: "node_modules/.bin/openpond-agent",
        dependencyPackages: [
          {
            packageName: "openpond-agent-sdk",
            source: "uploaded_tarball",
            versionSpec: "file:.openpond/local-sdk-source",
            path: ".openpond/vendor/openpond-agent-sdk.tgz",
            sha256: "sha_sdk",
            sizeBytes: 12000,
          },
        ],
      },
    };
  }
  if (workItemId === "work_item_missing_artifact_directory") {
    return {
      policyDiscovery: {
        status: "failed",
        message: "missing generated artifact directory .openpond",
        command: "bun run agent:inspect",
        exitCode: 1,
      },
    };
  }
  if (workItemId === "work_item_missing_source_upload_metadata") {
    return {
      sourceMaterialization: {
        status: "blocked",
        message: "missing .openpond/source-upload-metadata.json",
        blockedReason: "source_upload_metadata_missing",
      },
      policyDiscovery: {
        status: "blocked",
        message: "source-upload metadata missing",
      },
      publishBlockers: ["source_upload_metadata_missing"],
    };
  }
  if (workItemId === "work_item_stale_source_upload_metadata") {
    return {
      sourceUploadMetadata: {
        ...sourceUploadMetadataStatusFixture(),
        status: "stale",
        staleReasons: ["artifact_hash_mismatch"],
      },
      policyDiscovery: {
        status: "blocked",
        message: "source-upload metadata is stale",
      },
      publishBlockers: ["source_upload_metadata_stale"],
    };
  }
  if (workItemId === "work_item_invalid_inspect_json") {
    return {
      policyDiscovery: {
        status: "failed",
        message: "invalid inspect JSON",
        command: "bun run agent:inspect",
        exitCode: 1,
      },
    };
  }
  if (workItemId === "work_item_validation_failure") {
    return {
      checkRuns: [
        {
          command: "bun run agent:validate",
          status: "failed",
          passed: false,
          exitCode: 1,
          artifactRefs: ["artifacts/validator-report.json"],
        },
      ],
      validation: {
        status: "failed",
        passed: false,
        artifactRef: "artifacts/validator-report.json",
      },
      validatorArtifactRefs: ["artifacts/validator-report.json"],
    };
  }
  if (workItemId === "work_item_eval_failure") {
    return {
      checkRuns: [
        {
          command: "bun run agent:eval",
          status: "failed",
          passed: false,
          exitCode: 1,
          artifactRefs: ["artifacts/openpond-eval-results.json"],
        },
      ],
      eval: {
        status: "failed",
        passed: false,
        artifactRef: "artifacts/openpond-eval-results.json",
      },
      evalResultArtifactRefs: ["artifacts/openpond-eval-results.json"],
    };
  }
  if (workItemId === "work_item_publish_blocked") {
    return {
      deployPlan: {
        status: "blocked",
        canDeploy: false,
        blockedReasons: ["source_commit_sha_missing", "failed_checks"],
      },
      publishBlockers: ["source_commit_sha_missing", "failed_checks"],
    };
  }
  return {};
}

export function sandboxRecord(
  overrides: { runtimeId?: string | null } = {}
): Record<string, unknown> {
  return {
    id: "sandbox_test",
    state: "running",
    runtimeDriver: "remote-firecracker",
    repo: null,
    teamId: "team_test",
    projectId: null,
    agentId: null,
    visibility: "private",
    ownerUserId: "user_test",
    runtimeId: overrides.runtimeId ?? null,
    runtimeProfileId: "openpond-coding-core-v1",
    workspaceRoot: "/workspace/project",
    runtimeProfile: {
      id: "openpond-coding-core-v1",
      label: "OpenPond Coding Core",
      version: 1,
      workspaceRoot: "/workspace/project",
      defaultExecutionProfileId: "firecracker-direct-k8s",
      requiredTools: ["git", "sh", "rg", "curl", "tar", "unzip"],
      excludedToolchains: ["node", "bun", "python", "browser"],
      capabilities: [
        "files",
        "exec",
        "processes",
        "pty",
        "ports",
        "preview",
        "git",
      ],
    },
    executionProfileId: "firecracker-direct-k8s",
    billingAccountId: "billing_test",
    resources: { cpu: 1, memoryGb: 1, diskGb: 4 },
    budget: { maxUsd: "0.05" },
    quotas: {},
    reservation: {
      capturedUsd: "0",
      mpp: null,
    },
    commands: [],
    integrationLeases: [],
    previewPorts: [],
    snapshots: [],
    archive: null,
    receipts: [],
    logs: [],
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    startedAt: "2026-05-20T00:00:00.000Z",
    stoppedAt: null,
    deletedAt: null,
  };
}

export function sandboxGitPatchExportRecord(
  input: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    isRepo: true,
    baseRef:
      typeof input.baseRef === "string" && input.baseRef.trim()
        ? input.baseRef.trim()
        : "openpond/base",
    patch: "diff --git a/README.md b/README.md\n",
    filename: "sandbox_test-abc123.patch",
    sha256: "a".repeat(64),
    bytes: 35,
    lineCount: 2,
    empty: false,
  };
}

export function sandboxRuntimeRecord(
  overrides: {
    projectId?: string | null;
    agentId?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    id: "workspace_test",
    teamId: "team_test",
    userId: "user_test",
    projectId: overrides.projectId ?? null,
    agentId: overrides.agentId ?? null,
    sandboxId: "sandbox_test",
    workflowMode: "attempt",
    status: "waiting_for_user",
    baseBranch: "master",
    baseSha: null,
    currentSha: null,
    sourceRef: null,
    rootfsSnapshotId: null,
    dependencySnapshotId: null,
    checkpointSnapshotIds: [],
    artifactRefs: [],
    lifecyclePolicy: {
      mode: "auto",
      idleTimeoutSeconds: 900,
      archiveStoppedAfterSeconds: null,
      deleteAfterSeconds: null,
      retentionClass: "ephemeral",
    },
    checkpointPolicy: {
      workflow: "on_idle",
      source: "if_dirty",
      rootfs: "if_dirty",
      volumes: "explicit",
    },
    lifecycleState: {
      status: "waiting_for_user",
      lastInteractionAt: "2026-05-20T00:00:00.000Z",
      lastDirtyAt: null,
      lastCheckpointAt: null,
      lifecycleReason: "waiting_for_user",
    },
    promotionPolicy: "manual",
    permissions: {},
    runtimeProfileId: "openpond-coding-core-v1",
    workspaceRoot: "/workspace/project",
    runtimeProfile: {
      id: "openpond-coding-core-v1",
      label: "OpenPond Coding Core",
      version: 1,
      workspaceRoot: "/workspace/project",
      defaultExecutionProfileId: "firecracker-direct-k8s",
      requiredTools: ["git", "sh", "rg", "curl", "tar", "unzip"],
      excludedToolchains: ["node", "bun", "python", "browser"],
      capabilities: [
        "files",
        "exec",
        "processes",
        "pty",
        "ports",
        "preview",
        "git",
      ],
    },
    executionProfileId: "firecracker-direct-k8s",
    metadata: {},
    version: 2,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

export function sandboxProjectRecord(
  overrides: {
    name?: string;
    description?: string | null;
    status?: string;
    sourceType?: string;
    gitOwner?: string | null;
    gitRepo?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    id: "project_test",
    teamId: "team_test",
    createdByUserId: "user_test",
    name: overrides.name ?? "Demo Project",
    slug: "demo-project",
    description: overrides.description ?? null,
    status: overrides.status ?? "active",
    sourceType: overrides.sourceType ?? "internal_repo",
    sourceConfig: {},
    normalizedSourceIdentity: "internal_repo:openpond.ai:openpond/demo-project",
    externalId: null,
    gitProvider: null,
    gitHost: "openpond.ai",
    gitOwner: overrides.gitOwner ?? "openpond",
    gitRepo: overrides.gitRepo ?? "demo-project",
    gitBranch: null,
    defaultBranch: "master",
    internalRepoPath: null,
    templateSourceProjectId: null,
    templateRepoUrl: null,
    templateBranch: null,
    templateRemoteSha: null,
    sandboxManifest: null,
    sandboxActionRegistry: null,
    sandboxManifestHash: null,
    sandboxManifestPath: null,
    sandboxManifestSyncedAt: null,
    sandboxManifestError: null,
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    archivedAt:
      overrides.status === "archived" ? "2026-05-20T00:00:00.000Z" : null,
  };
}

export function sandboxAgentRecord(
  overrides: {
    name?: string;
    status?: string;
    triggerType?: string;
    selectedEntrypoint?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  return {
    id: "agent_test",
    teamId: "team_test",
    createdByUserId: "user_test",
    name: overrides.name ?? "Daily Report",
    slug: "daily-report",
    description: null,
    status: overrides.status ?? "active",
    projectId: "project_test",
    workflowIntent: null,
    selectedEntrypoint: overrides.selectedEntrypoint ?? {
      scope: "entire_manifest",
      name: null,
    },
    triggerType: overrides.triggerType ?? "manual",
    endpointPolicy: {},
    backgroundTaskPolicy: {},
    defaultWorkflowMode: "attempt",
    defaultBranch: null,
    sourceRefOverride: null,
    defaultPromotionPolicy: "manual",
    defaultResourcePolicy: {},
    defaultLifecyclePolicy: {},
    defaultCheckpointPolicy: {},
    requiredIntegrationRefs: [],
    requiredEnvironmentVariableRefs: [],
    schedulePolicy: {},
    externalId: null,
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    archivedAt:
      overrides.status === "archived" ? "2026-05-20T00:00:00.000Z" : null,
  };
}

export function sandboxAgentRunRecord(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: "agent_run_test",
    teamId: "team_test",
    projectId: "project_test",
    agentId: "agent_test",
    requestedByUserId: "user_test",
    idempotencyKey: input.idempotencyKey ?? null,
    triggerType: input.triggerType ?? "manual",
    status: "running",
    runtimeId: "workspace_test",
    sandboxId: "sandbox_test",
    selectedEntrypoint: { scope: "action", name: "hello" },
    input: input.input ?? {},
    metadata: input.metadata ?? {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    completedAt: null,
  };
}

export function sandboxAgentSourceDeployPlanRecord(): Record<string, unknown> {
  return {
    projectId: "project_test",
    agentId: "agent_test",
    status: "ready",
    canRun: true,
    canDeploy: true,
    blockedReasons: [],
    staleReasons: [],
    source: {
      sourceRef: "master",
      sourceCommitSha: "sha_test",
      manifestHash: "hash_test",
      manifestPath: "openpond.yaml",
      manifestSyncedAt: "2026-05-20T00:00:00.000Z",
      activeSnapshotId: null,
      activeSnapshotSourceSha: null,
    },
    defaultEntrypoint: { scope: "action", name: "chat" },
    checks: {
      setupCommands: [],
      validationCommands: ["openpond-agent validate"],
      requiredChecks: ["openpond-agent validate"],
      evalNames: ["basic"],
    },
    actions: [],
    channels: [],
    requiredIntegrations: [],
    optionalIntegrations: [],
    envRefs: [],
    requiredVolumes: [],
    optionalVolumes: [],
    schedules: [],
    artifactPaths: ["artifacts/openpond-trace.jsonl"],
    editable: {
      enabled: true,
      requiredChecks: ["openpond-agent validate"],
      defaultResultMode: "patch_only",
      supportedResultModes: ["patch_only"],
    },
  };
}

export function sandboxAgentManifestSnapshotRecord(): Record<string, unknown> {
  return {
    id: "snapshot_test",
    teamId: "team_test",
    projectId: "project_test",
    agentId: "agent_test",
    sourceRef: "master",
    sourceCommitSha: "sha_test",
    manifestHash: "hash_test",
    manifestPath: "openpond.yaml",
    manifestSyncedAt: "2026-05-20T00:00:00.000Z",
    manifestJson: {},
    actionRegistryJson: {},
    inspectJson: {},
    buildStatus: "passed",
    validationStatus: "passed",
    evalStatus: "passed",
    workItemId: "work_item_test",
    taskRunId: "task_run_test",
    traceArtifactRef: "artifacts/openpond-trace.jsonl",
    evalResultArtifactRef: "artifacts/openpond-eval-results.json",
    publishedAt: "2026-05-20T00:00:00.000Z",
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
  };
}

export function sandboxCommandRecord(command: string): Record<string, unknown> {
  return {
    id: "command_test",
    command,
    status: "succeeded",
    output: "",
    exitCode: 0,
    startedAt: "2026-05-20T00:00:00.000Z",
    completedAt: "2026-05-20T00:00:01.000Z",
  };
}

export function sandboxProcessRecord(command: string): Record<string, unknown> {
  return {
    id: "process_test",
    command,
    status: "succeeded",
    output: "",
    exitCode: 0,
    startedAt: "2026-05-20T00:00:00.000Z",
    completedAt: "2026-05-20T00:00:01.000Z",
    durationMs: 1000,
    outputBytes: 0,
  };
}

export function sandboxScheduleRecord(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: "schedule_test",
    teamId: "team_test",
    ownerUserId: "user_test",
    createdByUserId: "user_test",
    name: input.name,
    description: input.description ?? null,
    scheduleType: input.scheduleType,
    scheduleExpression: input.scheduleExpression,
    enabled: input.enabled ?? true,
    timezone: input.timezone ?? null,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    maxRuns: input.maxRuns ?? null,
    executionCount: 0,
    lifecycleStatus: "active",
    lifecycleReason: null,
    runtimePolicy: input.runtimePolicy ?? "run_and_stop",
    sourceSandboxId: input.sourceSandboxId ?? null,
    snapshotId: input.snapshotId ?? null,
    templateId: input.templateId ?? null,
    target: input.target ?? {
      kind: "command",
      actionName: null,
      command: null,
      requiresStart: false,
    },
    budget: input.budget ?? null,
    resources: input.resources ?? null,
    quotas: input.quotas ?? null,
    lifecycle: input.lifecycle ?? null,
    retentionPolicy: input.retentionPolicy ?? null,
    env: input.env ?? [],
    integrationLeases: input.integrationLeases ?? [],
    metadata: input.metadata ?? {},
    managementSource: input.managementSource ?? "api",
    manifestPath: input.manifestPath ?? null,
    awsScheduleProvider: null,
    awsScheduleName: null,
    awsScheduleArn: null,
    syncStatus: "pending",
    syncError: null,
    syncRequestedAt: null,
    lastSyncedAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

export function sandboxPricingRateCard(): Record<string, unknown> {
  return {
    currency: "USD",
    source: "openpond_poc_config",
    effectiveAt: "2026-05-20T00:00:00.000Z",
    rates: [
      {
        key: "cpu",
        label: "vCPU",
        unit: "vCPU-second",
        unitPriceUsd: "0.000010",
        unitPriceHourlyUsd: "0.036000",
        unitPriceMonthlyUsd: null,
      },
      {
        key: "memory",
        label: "Memory",
        unit: "GiB-second",
        unitPriceUsd: "0.000003",
        unitPriceHourlyUsd: "0.010800",
        unitPriceMonthlyUsd: null,
      },
      {
        key: "disk",
        label: "VM disk",
        unit: "GiB-second",
        unitPriceUsd: "0.000000",
        unitPriceHourlyUsd: "0.000072",
        unitPriceMonthlyUsd: null,
      },
      {
        key: "durable_volume_storage",
        label: "Durable volume storage",
        unit: "GiB-second",
        unitPriceUsd: "0.000000",
        unitPriceHourlyUsd: "0.000072",
        unitPriceMonthlyUsd: "0.051840",
      },
    ],
    tiers: [
      {
        key: "default",
        label: "Default",
        description:
          "Normal app workspaces, small dev servers, and basic test runs.",
        resources: {
          cpu: 1,
          memoryGb: 2,
          diskGb: 10,
        },
        goodFit: ["normal app workspace"],
        poorFit: ["large dependency installs"],
        keepRunningEstimate: {
          resources: {
            cpu: 1,
            memoryGb: 2,
            diskGb: 10,
          },
          matchedTierKey: "default",
          hourlyUsd: "0.058320",
          monthlyUsd: "41.990400",
          durationDays: 30,
          pricingSource: "openpond_poc_config",
          lineItems: [
            {
              label: "vCPU",
              quantity: 1,
              unit: "vCPU",
              hourlyUsd: "0.036000",
              monthlyUsd: "25.920000",
            },
            {
              label: "Memory",
              quantity: 2,
              unit: "GiB",
              hourlyUsd: "0.021600",
              monthlyUsd: "15.552000",
            },
            {
              label: "VM disk",
              quantity: 10,
              unit: "GiB",
              hourlyUsd: "0.000720",
              monthlyUsd: "0.518400",
            },
          ],
        },
      },
    ],
  };
}

export function sandboxSecretRecord(input: {
  name: string;
  status?: string;
  secretRef?: string;
  currentVersion?: number;
  attachments?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    id: "secret_test",
    teamId: "team_test",
    ownerUserId: "user_test",
    name: input.name,
    description: null,
    scope: "team",
    status: input.status ?? "active",
    secretRef: input.secretRef ?? "openpond://secret/team_test/secret_test#v1",
    currentVersion: input.currentVersion ?? 1,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    lastUsedAt: null,
    deletedAt: input.status === "deleted" ? "2026-05-20T00:01:00.000Z" : null,
    attachments: input.attachments ?? [],
  };
}
