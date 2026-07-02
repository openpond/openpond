import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { OpenPondSandboxClient } from "../sandbox/client";
import type {
  SandboxCreateInput,
  SandboxIntegrationConnectionLeaseInput,
  SandboxRecord,
  SandboxReplayArtifact,
  SandboxReplayInput,
  SandboxReplayRecord,
  SandboxSnapshotValidateInput,
  SandboxTemplateBuildCreateInput,
  SandboxTemplateBuildRecord,
} from "../sandbox/types/index";
import {
  parseBooleanOption,
  parseCsvOption,
  parseIntegerOption,
  parseJsonOption,
  parseNumberOption,
  parseSandboxEnvOptions,
  parseSandboxRuntimeProfileIdOption,
  parseSandboxWorkflowModeOption,
  parseSandboxRuntimePromotionPolicyOption,
  type SandboxCreatePlan,
  type SandboxCreatePlanResult,
} from "./common";

const DOCKER_CONTEXT_MAX_FILES = 500;
const DOCKER_CONTEXT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DOCKER_CONTEXT_MAX_BYTES = 8 * 1024 * 1024;

export async function createSandboxFromPlan(
  client: OpenPondSandboxClient,
  plan: SandboxCreatePlan
): Promise<SandboxCreatePlanResult> {
  if (!plan.sandboxRuntime && !plan.runtimeId) {
    return {
      sandbox: await waitForSandboxCreateReady(
        client,
        await client.create(plan.sandbox, { async: true })
      ),
    };
  }

  const runtime = plan.runtimeId
    ? undefined
    : await client.createSandboxRuntime(plan.sandboxRuntime!);
  const runtimeId = plan.runtimeId ?? runtime!.id;
  const result = await client.createSandboxRuntimeSandbox(
    runtimeId,
    plan.sandbox
  );
  return {
    sandbox: await waitForSandboxCreateReady(client, result.sandbox),
    runtime: result.runtime ?? runtime,
  };
}

export async function waitForSandboxCreateReady(
  client: OpenPondSandboxClient,
  sandbox: SandboxRecord
): Promise<SandboxRecord> {
  if (sandbox.state === "running" || sandbox.state === "stopped") {
    return sandbox;
  }
  if (sandbox.state === "error") {
    throw new Error(
      `sandbox create failed: ${sandbox.id}\n${sandbox.logs.join("\n")}`
    );
  }

  const timeoutMs = 12 * 60_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let latest = sandbox;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    latest = await client.get(sandbox.id);
    if (latest.state === "running" || latest.state === "stopped") {
      return latest;
    }
    if (latest.state === "error") {
      throw new Error(
        `sandbox create failed: ${latest.id}\n${latest.logs.join("\n")}`
      );
    }
  }
  throw new Error(
    `sandbox create did not reach running state before timeout: ${latest.id} (${latest.state})`
  );
}

export function formatSandboxLine(sandbox: SandboxRecord): string {
  const mppMode = sandbox.reservation.mpp?.mode ?? "no-mpp";
  const captured = sandbox.reservation.capturedUsd;
  const budget = sandbox.budget.maxUsd;
  const repo = sandbox.repo ?? "-";
  return [
    sandbox.id,
    sandbox.state,
    sandbox.runtimeDriver,
    `spent=${captured}/${budget}`,
    mppMode,
    repo,
  ].join("  ");
}

export function formatSnapshotCatalogLine(snapshot: {
  id: string;
  kind: string;
  sandboxId: string;
  name: string;
  storage: string | null;
  sizeGb: number | null;
  template?: {
    name: string;
    version: string;
  } | null;
  replay?: {
    state?: string | null;
    retention?: {
      class?: string | null;
    } | null;
  } | null;
  storageCost?: {
    estimatedMonthlyUsd: string | null;
    retentionClass: string | null;
  } | null;
  createdAt: string;
}): string {
  const template = snapshot.template
    ? `${snapshot.template.name}@${snapshot.template.version}`
    : "-";
  const retention =
    snapshot.replay?.retention?.class ??
    snapshot.storageCost?.retentionClass ??
    "-";
  const replayState = snapshot.replay?.state ?? "-";
  const monthlyUsd = snapshot.storageCost?.estimatedMonthlyUsd ?? "-";
  return [
    snapshot.id,
    snapshot.kind,
    snapshot.name,
    snapshot.sandboxId,
    `storage=${snapshot.storage ?? "-"}`,
    `sizeGb=${snapshot.sizeGb ?? "-"}`,
    `publishedSnapshot=${template}`,
    `replay=${replayState}`,
    `retention=${retention}`,
    `monthlyUsd=${monthlyUsd}`,
    snapshot.createdAt,
  ].join("  ");
}

export function formatSandboxTemplateLine(template: {
  snapshotId: string;
  sandboxId: string;
  name: string;
  version: string;
  visibility: string;
  useCase: string | null;
  tags?: string[];
  replay?: {
    state?: string | null;
    retention?: {
      class?: string | null;
    } | null;
  } | null;
  storageCost?: {
    estimatedMonthlyUsd: string | null;
    retentionClass: string | null;
  } | null;
  createdAt: string;
}): string {
  const tags =
    template.tags && template.tags.length > 0 ? template.tags.join(",") : "-";
  const retention =
    template.replay?.retention?.class ??
    template.storageCost?.retentionClass ??
    "-";
  const replayState = template.replay?.state ?? "-";
  const monthlyUsd = template.storageCost?.estimatedMonthlyUsd ?? "-";
  return [
    template.name,
    `version=${template.version}`,
    `snapshot=${template.snapshotId}`,
    `sandbox=${template.sandboxId}`,
    `visibility=${template.visibility}`,
    `useCase=${template.useCase ?? "-"}`,
    `tags=${tags}`,
    `replay=${replayState}`,
    `retention=${retention}`,
    `monthlyUsd=${monthlyUsd}`,
    template.createdAt,
  ].join("  ");
}

export function formatTemplateBuildLine(
  build: SandboxTemplateBuildRecord
): string {
  return [
    build.id,
    `team=${build.teamId}`,
    `status=${build.status}`,
    `publish=${build.publishStatus ?? "-"}`,
    `source=${build.sourceRepoUrl}`,
    `branch=${build.sourceBranch}`,
    `snapshot=${build.snapshotId ?? "-"}`,
    `error=${build.error ?? "-"}`,
    build.createdAt ?? "-",
  ].join("  ");
}

export function formatReplayLine(replay: SandboxReplayRecord): string {
  return [
    replay.id,
    `team=${replay.teamId}`,
    `state=${replay.state}`,
    `snapshot=${replay.snapshotId}`,
    `sandbox=${replay.sandboxId ?? "-"}`,
    `command=${replay.commandId ?? "-"}`,
    `exit=${replay.exitCode ?? "-"}`,
    `cleanup=${replay.cleanup.action}:${replay.cleanup.status}`,
    `error=${replay.error ?? "-"}`,
    replay.createdAt,
  ].join("  ");
}

export function summarizeReplayArtifact(
  artifact: SandboxReplayArtifact
): Record<string, unknown> {
  return {
    path: artifact.path,
    status: artifact.status,
    sizeBytes: artifact.sizeBytes,
    error: artifact.error,
    ...(artifact.contentsBase64
      ? {
          contentsBase64: artifact.contentsBase64,
        }
      : {}),
  };
}

export function normalizeSnapshotValidationCleanup(
  value: unknown
): SandboxSnapshotValidateInput["cleanup"] | undefined {
  if (typeof value !== "string") return undefined;
  const cleanup = value.trim();
  if (cleanup === "delete" || cleanup === "stop" || cleanup === "archive") {
    return cleanup;
  }
  throw new Error(
    "snapshot-validate --cleanup must be delete, stop, or archive"
  );
}

export function normalizeReplayCleanup(
  value: unknown
): SandboxReplayInput["cleanup"] | undefined {
  if (typeof value !== "string") return undefined;
  const cleanup = value.trim();
  if (cleanup === "delete" || cleanup === "stop" || cleanup === "archive") {
    return cleanup;
  }
  throw new Error("replay cleanup must be delete, stop, or archive");
}

export function buildSandboxReplayInput(
  options: Record<string, string | boolean>
): SandboxReplayInput & { teamId?: string; projectId?: string } {
  const snapshotId =
    typeof options.snapshotId === "string" && options.snapshotId.trim()
      ? options.snapshotId.trim()
      : typeof options.snapshot === "string" && options.snapshot.trim()
      ? options.snapshot.trim()
      : "";
  if (!snapshotId) {
    throw new Error("replay-start requires --snapshot-id <id>");
  }
  const teamId =
    typeof options.teamId === "string" ? options.teamId.trim() : "";
  const projectId =
    typeof options.projectId === "string" ? options.projectId.trim() : "";
  const sourceSandboxId =
    typeof options.sourceSandboxId === "string" &&
    options.sourceSandboxId.trim()
      ? options.sourceSandboxId.trim()
      : "";
  const entrypoint =
    typeof options.entrypoint === "string" && options.entrypoint.trim()
      ? options.entrypoint.trim()
      : "";
  const params =
    typeof options.params === "string" && options.params.trim()
      ? parseJsonOption(options.params, "params")
      : {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("params must be a JSON object");
  }
  const budgetUsd =
    typeof options.budgetUsd === "string" && options.budgetUsd.trim()
      ? options.budgetUsd.trim()
      : typeof options.budget === "string" && options.budget.trim()
      ? options.budget.trim()
      : "";
  const maxDurationSeconds = parseIntegerOption(
    options.maxDurationSeconds,
    "max-duration-seconds"
  );
  const idleTimeoutSeconds = parseIntegerOption(
    options.idleTimeoutSeconds,
    "idle-timeout-seconds"
  );
  const artifactPaths = parseCsvOption(options.artifactPaths);
  const idempotencyKey =
    typeof options.idempotencyKey === "string" && options.idempotencyKey.trim()
      ? options.idempotencyKey.trim()
      : "";
  const cleanup = normalizeReplayCleanup(options.cleanup);
  return {
    snapshotId,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sourceSandboxId ? { sourceSandboxId } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    params: params as Record<string, unknown>,
    ...(budgetUsd ? { budget: { maxUsd: budgetUsd } } : {}),
    ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
    ...(idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {}),
    ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(cleanup ? { cleanup } : {}),
  };
}

export function buildSandboxCreateInput(
  options: Record<string, string | boolean>
): SandboxCreatePlan {
  const repo = typeof options.repo === "string" ? options.repo.trim() : "";
  const command =
    typeof options.command === "string" && options.command.trim()
      ? options.command.trim()
      : undefined;
  const budgetUsd =
    typeof options.budgetUsd === "string" && options.budgetUsd.trim()
      ? options.budgetUsd.trim()
      : typeof options.budget === "string" && options.budget.trim()
      ? options.budget.trim()
      : "0.05";
  const cpu = parseNumberOption(options.cpu, "cpu");
  const memoryGb = parseNumberOption(options.memoryGb, "memory-gb");
  const diskGb = parseNumberOption(options.diskGb, "disk-gb");
  const maxDurationSeconds = parseIntegerOption(
    options.maxDurationSeconds,
    "max-duration-seconds"
  );
  const idleTimeoutSeconds = parseIntegerOption(
    options.idleTimeoutSeconds,
    "idle-timeout-seconds"
  );
  const volumeName =
    typeof options.volumeName === "string" && options.volumeName.trim()
      ? options.volumeName.trim()
      : "";
  const volumeMountPath =
    typeof options.volumeMountPath === "string" &&
    options.volumeMountPath.trim()
      ? options.volumeMountPath.trim()
      : "";
  const volumeStorageGb = parseIntegerOption(
    options.volumeStorageGb,
    "volume-storage-gb"
  );
  const volumeDeleteOnSandboxDelete =
    options.volumeDeleteOnSandboxDelete !== undefined
      ? parseBooleanOption(options.volumeDeleteOnSandboxDelete)
      : undefined;
  const integrationConnection =
    typeof options.integrationConnection === "string"
      ? options.integrationConnection.trim()
      : "";
  const integrationCapabilities = parseCsvOption(
    options.integrationCapabilities
  );
  const integrationScopes = parseCsvOption(options.integrationScopes);
  const teamId =
    typeof options.teamId === "string" ? options.teamId.trim() : "";
  const requestedProjectId =
    typeof options.projectId === "string" ? options.projectId.trim() : "";
  const sandboxRuntimeProjectId =
    typeof options.runtimeProjectId === "string"
      ? options.runtimeProjectId.trim()
      : "";
  if (
    requestedProjectId &&
    sandboxRuntimeProjectId &&
    requestedProjectId !== sandboxRuntimeProjectId
  ) {
    throw new Error(
      "project-id and runtime-project-id must match when both are set"
    );
  }
  const projectId = requestedProjectId || sandboxRuntimeProjectId;
  const requestedAgentId =
    typeof options.agentId === "string" ? options.agentId.trim() : "";
  const sandboxRuntimeAgentId =
    typeof options.runtimeAgentId === "string"
      ? options.runtimeAgentId.trim()
      : "";
  if (
    requestedAgentId &&
    sandboxRuntimeAgentId &&
    requestedAgentId !== sandboxRuntimeAgentId
  ) {
    throw new Error(
      "agent-id and runtime-agent-id must match when both are set"
    );
  }
  const agentId = requestedAgentId || sandboxRuntimeAgentId;
  const sandboxWorkflowMode = parseSandboxWorkflowModeOption(options.workflowMode);
  const sandboxRuntimePromotionPolicy =
    parseSandboxRuntimePromotionPolicyOption(options.runtimePromotionPolicy);
  const workloadSource = buildSandboxWorkloadSourceInput(options);
  const sourceArchive = buildDockerfileSourceArchiveInput(options);
  const runtimeProfileId = parseSandboxRuntimeProfileIdOption(
    options.runtimeProfileId
  );
  const sandboxRuntimeBaseBranch =
    typeof options.runtimeBaseBranch === "string" &&
    options.runtimeBaseBranch.trim()
      ? options.runtimeBaseBranch.trim()
      : "";
  const sandboxRuntimeBaseSha =
    typeof options.runtimeBaseSha === "string" && options.runtimeBaseSha.trim()
      ? options.runtimeBaseSha.trim()
      : "";
  const runtimeId =
    typeof options.runtimeId === "string" && options.runtimeId.trim()
      ? options.runtimeId.trim()
      : "";
  const sandboxRuntimeRequested = Boolean(
    sandboxWorkflowMode ||
      sandboxRuntimePromotionPolicy ||
      sandboxRuntimeBaseBranch ||
      sandboxRuntimeBaseSha ||
      runtimeProfileId ||
      runtimeId ||
      sandboxRuntimeProjectId ||
      sandboxRuntimeAgentId
  );
  const env = parseSandboxEnvOptions(options);

  if (integrationConnection && integrationCapabilities.length === 0) {
    throw new Error(
      "integration-capabilities is required with integration-connection"
    );
  }

  const sandbox: SandboxCreateInput = {
    ...(repo ? { repo } : {}),
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
    ...(command ? { command } : {}),
    ...(workloadSource ? { workloadSource } : {}),
    ...(sourceArchive ? { sourceArchive } : {}),
    resources: {
      ...(cpu !== undefined ? { cpu } : {}),
      ...(memoryGb !== undefined ? { memoryGb } : {}),
      ...(diskGb !== undefined ? { diskGb } : {}),
    },
    budget: { maxUsd: budgetUsd },
    quotas: {
      maxSpendUsd: budgetUsd,
      ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
      ...(idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {}),
    },
    ...(env.length > 0 ? { env } : {}),
    ...(volumeName || volumeMountPath || volumeStorageGb !== undefined
      ? {
          volumes: [
            {
              ...(volumeName ? { name: volumeName } : {}),
              ...(volumeMountPath ? { mountPath: volumeMountPath } : {}),
              ...(volumeStorageGb !== undefined
                ? { storageGb: volumeStorageGb }
                : {}),
              ...(volumeDeleteOnSandboxDelete !== undefined
                ? { deleteOnSandboxDelete: volumeDeleteOnSandboxDelete }
                : {}),
            },
          ],
        }
      : {}),
    ...(integrationConnection
      ? {
          integrationConnectionLeases: [
            {
              connectionId: integrationConnection,
              ...(integrationScopes.length > 0
                ? { scopes: integrationScopes }
                : {}),
              capabilities: integrationCapabilities,
              ttlSeconds: 60 * 60,
            },
          ],
        }
      : {}),
    metadata: {
      source: "openpond-code",
    },
  };
  return {
    sandbox,
    ...(sandboxRuntimeRequested && runtimeId ? { runtimeId } : {}),
    ...(sandboxRuntimeRequested && !runtimeId
      ? {
          sandboxRuntime: {
            ...(teamId ? { teamId } : {}),
            ...(sandboxWorkflowMode ? { workflowMode: sandboxWorkflowMode } : {}),
            ...(projectId ? { projectId } : {}),
            ...(agentId ? { agentId } : {}),
            baseBranch: sandboxRuntimeBaseBranch || "master",
            ...(sandboxRuntimeBaseSha
              ? { baseSha: sandboxRuntimeBaseSha }
              : {}),
            ...(sandboxRuntimePromotionPolicy
              ? { promotionPolicy: sandboxRuntimePromotionPolicy }
              : {}),
            ...(runtimeProfileId ? { runtimeProfileId } : {}),
          },
        }
      : {}),
  };
}

function isSafeDockerContextPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")
  );
}

function shouldSkipDockerContextPath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some((segment) => {
    const lower = segment.toLowerCase();
    return (
      lower === ".git" ||
      lower === "node_modules" ||
      lower === ".next" ||
      lower === ".turbo" ||
      lower.startsWith(".env")
    );
  });
}

function collectDockerContextFiles(params: {
  contextRoot: string;
  baseDir?: string;
}): string[] {
  const baseDir = params.baseDir ?? params.contextRoot;
  const entries = readdirSync(baseDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(baseDir, entry.name);
    const relativePath = path
      .relative(params.contextRoot, absolutePath)
      .replace(/\\/g, "/");
    if (
      !relativePath ||
      !isSafeDockerContextPath(relativePath) ||
      shouldSkipDockerContextPath(relativePath)
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(
        ...collectDockerContextFiles({
          contextRoot: params.contextRoot,
          baseDir: absolutePath,
        })
      );
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function buildDockerfileSourceArchiveInput(
  options: Record<string, string | boolean>
): SandboxCreateInput["sourceArchive"] | undefined {
  const dockerfilePath = stringOption(options.dockerfile);
  if (!dockerfilePath) {
    return undefined;
  }
  const contextPath = stringOption(options.dockerfileContext) || ".";
  const contextRoot = path.resolve(process.cwd(), contextPath);
  const contextStat = statSync(contextRoot);
  if (!contextStat.isDirectory()) {
    throw new Error(`dockerfile context must be a directory: ${contextPath}`);
  }

  const sourcePaths = collectDockerContextFiles({ contextRoot }).sort();
  if (sourcePaths.length === 0) {
    throw new Error(`dockerfile context has no files: ${contextPath}`);
  }
  if (sourcePaths.length > DOCKER_CONTEXT_MAX_FILES) {
    throw new Error(
      `dockerfile context has too many files: ${sourcePaths.length} > ${DOCKER_CONTEXT_MAX_FILES}`
    );
  }

  let totalBytes = 0;
  const entries = sourcePaths.map((sourcePath) => {
    const absolutePath = path.resolve(contextRoot, sourcePath);
    const relative = path.relative(contextRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`dockerfile context path escapes context: ${sourcePath}`);
    }
    const stat = statSync(absolutePath);
    if (stat.size > DOCKER_CONTEXT_MAX_FILE_BYTES) {
      throw new Error(
        `dockerfile context file is too large: ${sourcePath} (${stat.size} bytes)`
      );
    }
    totalBytes += stat.size;
    if (totalBytes > DOCKER_CONTEXT_MAX_BYTES) {
      throw new Error(
        `dockerfile context is too large: ${totalBytes} > ${DOCKER_CONTEXT_MAX_BYTES}`
      );
    }
    return {
      path: sourcePath,
      type: "file" as const,
      contentsBase64: Buffer.from(readFileSync(absolutePath)).toString("base64"),
    };
  });

  return {
    source: "client_upload",
    ref: "client-upload",
    archive: {
      version: 1,
      createdAt: new Date().toISOString(),
      entries,
    },
  };
}

function buildSandboxWorkloadSourceInput(
  options: Record<string, string | boolean>
): SandboxCreateInput["workloadSource"] | undefined {
  const imageRef = stringOption(options.image);
  const dockerfilePath = stringOption(options.dockerfile);
  if (imageRef && dockerfilePath) {
    throw new Error("sandbox create accepts only one of --image or --dockerfile");
  }
  const workspaceRoot = stringOption(options.runtimeWorkspaceRoot);
  if (imageRef) {
    return {
      image: {
        ref: imageRef,
        ...(stringOption(options.imageDigest)
          ? { digest: stringOption(options.imageDigest) }
          : {}),
        ...(stringOption(options.registrySecretRef)
          ? { registrySecretRef: stringOption(options.registrySecretRef) }
          : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        platform: "linux/amd64",
      },
    };
  }
  if (dockerfilePath) {
    const buildArgs = parseDockerBuildArgs(options.dockerBuildArgs);
    const registrySecretRefs = parseCsvOption(options.dockerRegistrySecretRefs);
    return {
      dockerfile: {
        path: dockerfilePath,
        context: stringOption(options.dockerfileContext) || ".",
        ...(stringOption(options.dockerfileTarget)
          ? { target: stringOption(options.dockerfileTarget) }
          : {}),
        ...(Object.keys(buildArgs).length > 0 ? { buildArgs } : {}),
        ...(registrySecretRefs.length > 0 ? { registrySecretRefs } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        platform: "linux/amd64",
      },
    };
  }
  return undefined;
}

function parseDockerBuildArgs(
  value: string | boolean | undefined
): Record<string, string> {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  const parsed = parseJsonOption(value, "docker-build-args");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("docker-build-args must be a JSON object");
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== "string") {
      throw new Error("docker-build-args values must be strings");
    }
    result[key] = rawValue;
  }
  return result;
}

function stringOption(value: string | boolean | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildSandboxIntegrationAttachInput(
  options: Record<string, string | boolean>
): SandboxIntegrationConnectionLeaseInput {
  const connectionId =
    typeof options.integrationConnection === "string"
      ? options.integrationConnection.trim()
      : "";
  const capabilities = parseCsvOption(options.integrationCapabilities);
  const scopes = parseCsvOption(options.integrationScopes);
  if (!connectionId || capabilities.length === 0) {
    throw new Error(
      "usage: sandbox integration-attach <sandboxId> --integration-connection <id> --integration-capabilities <csv>"
    );
  }
  return {
    connectionId,
    ...(scopes.length > 0 ? { scopes } : {}),
    capabilities,
    ttlSeconds: 60 * 60,
  };
}

export function buildTemplateBuildCreateInput(
  options: Record<string, string | boolean>
): SandboxTemplateBuildCreateInput {
  const teamId =
    typeof options.teamId === "string" ? options.teamId.trim() : "";
  const sourceRepoUrl =
    typeof options.sourceRepoUrl === "string"
      ? options.sourceRepoUrl.trim()
      : "";
  const sourceProjectId =
    typeof options.sourceProjectId === "string"
      ? options.sourceProjectId.trim()
      : "";
  const branch =
    typeof options.branch === "string" ? options.branch.trim() : "";
  const manifestPath =
    typeof options.manifestPath === "string" ? options.manifestPath.trim() : "";
  if (!teamId) {
    throw new Error("published-snapshot-build-create requires --team-id <id>");
  }
  if (!sourceRepoUrl && !sourceProjectId) {
    throw new Error(
      "published-snapshot-build-create requires --source-repo-url <url> or --source-project-id <id>"
    );
  }
  return {
    teamId,
    ...(sourceRepoUrl ? { sourceRepoUrl } : {}),
    ...(sourceProjectId ? { sourceProjectId } : {}),
    ...(branch ? { branch } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    publish: parseBooleanOption(options.publish),
  };
}

export function buildSnapshotCreateInput(
  options: Record<string, string | boolean>
): Record<string, unknown> {
  const name = typeof options.name === "string" ? options.name.trim() : "";
  if (!name) {
    throw new Error("snapshot-create requires --name <name>");
  }
  const templateName =
    typeof options.templateName === "string" ? options.templateName.trim() : "";
  const templateVersion =
    typeof options.templateVersion === "string" &&
    options.templateVersion.trim()
      ? options.templateVersion.trim()
      : "0.1.0";
  const templateVisibility =
    typeof options.templateVisibility === "string" &&
    options.templateVisibility.trim()
      ? options.templateVisibility.trim()
      : "private";
  if (templateVisibility !== "private" && templateVisibility !== "team") {
    throw new Error("template-visibility must be private or team");
  }
  const validationCommand =
    typeof options.validationCommand === "string" &&
    options.validationCommand.trim()
      ? options.validationCommand.trim()
      : "test -d .";
  const entrypointCommand =
    typeof options.entrypointCommand === "string" &&
    options.entrypointCommand.trim()
      ? options.entrypointCommand.trim()
      : "true";
  const useCase =
    typeof options.useCase === "string" && options.useCase.trim()
      ? options.useCase.trim()
      : undefined;
  const description =
    typeof options.description === "string" && options.description.trim()
      ? options.description.trim()
      : undefined;
  const tags = parseCsvOption(options.tags);
  const input: Record<string, unknown> = {
    ...(parseBooleanOption(options.async) ? { async: true } : {}),
    name,
    replay: {
      entrypoints: [
        {
          command: entrypointCommand,
          name: "default",
        },
      ],
      retention: {
        class: "pinned",
      },
      safety: {
        cleanup: "delete",
        idleTimeoutSeconds: 600,
        internetEgress: "block",
        maxDurationSeconds: 600,
        maxSpendUsd: "0.05",
        publicPreview: false,
      },
      validation: {
        commands: [
          {
            command: validationCommand,
          },
        ],
      },
    },
  };
  if (templateName) {
    input.template = {
      name: templateName,
      version: templateVersion,
      ...(description ? { description } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      visibility: templateVisibility,
      ...(useCase ? { useCase } : {}),
    };
  }
  return input;
}

export function summarizeSandbox(
  sandbox: SandboxRecord
): Record<string, unknown> {
  return {
    id: sandbox.id,
    state: sandbox.state,
    runtimeDriver: sandbox.runtimeDriver,
    repo: sandbox.repo,
    runtimeId: sandbox.runtimeId ?? null,
    repoRef: sandbox.repoRef ?? null,
    sourceCommitSha: sandbox.sourceCommitSha ?? null,
    budgetUsd: sandbox.budget.maxUsd,
    capturedUsd: sandbox.reservation.capturedUsd,
    reservationRef: sandbox.reservation.mpp?.reservationRef ?? null,
    mppMode: sandbox.reservation.mpp?.mode ?? null,
    integrationLeases:
      sandbox.integrationLeases?.map((lease) => ({
        leaseId: lease.leaseId,
        provider: lease.provider,
        capabilities: lease.capabilities,
      })) ?? [],
    previewPorts: sandbox.previewPorts.map((preview) => ({
      port: preview.port,
      label: preview.label,
      url: preview.url,
      customDomain: preview.customDomain ?? null,
    })),
    latestReceipt: sandbox.receipts.at(-1)?.mpp.receiptRef ?? null,
  };
}
