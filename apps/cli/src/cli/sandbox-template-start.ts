import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { OpenPondSandboxClient } from "../sandbox/client";
import type {
  SandboxCreateInput,
  SandboxRecord,
  SandboxScheduleCreateInput,
} from "../sandbox/types/index";
import {
  OPENPOND_MANIFEST_FILE_NAME,
  formatSandboxTemplateDiagnostics,
  sandboxTemplateExecutableEntries,
  validateSandboxTemplateYaml,
  type SandboxTemplateExecutable,
  type SandboxTemplateManifest,
  type SandboxTemplatePort,
} from "../sandbox-template/manifest";
import {
  parseIntegerOption,
  parseJsonOption,
  parseSandboxWorkflowModeOption,
  parseSandboxRuntimePromotionPolicyOption,
  parseSandboxTemplateEnvOptions,
  resolveSandboxClient,
  type SandboxCreatePlan,
} from "./common";
import { createSandboxFromPlan, summarizeSandbox } from "./sandbox-helpers";
import { createSandboxTemplateStartSchedules } from "./sandbox-template-schedules";
export {
  buildSandboxTemplateStartScheduleInput,
  createSandboxTemplateStartSchedules,
  mergeSandboxTemplateScheduleOverride,
  parseSandboxTemplateScheduleNameSelection,
  parseSandboxTemplateScheduleOverrides,
  resolveSandboxTemplateStartScheduleSelection,
  sandboxTemplateScheduleCommandTarget,
  sandboxTemplateScheduleExpression,
  type SandboxTemplateScheduleOverride,
  type SandboxTemplateStartScheduleMode,
} from "./sandbox-template-schedules";
import {
  normalizeSandboxTemplateRepoIdentity,
  resolveSandboxTemplateStartRepo,
} from "./sandbox-template-git";
export {
  ensureGitCommitForSandboxTemplateStart,
  ensureGitRepository,
  normalizeSandboxTemplateRepoIdentity,
  normalizeSandboxTemplateRepoUrl,
  pushGitBranchForSandboxTemplateStart,
  resolveSandboxTemplateStartBranch,
  resolveSandboxTemplateStartRepo,
} from "./sandbox-template-git";
import {
  SandboxTemplateScalarInputs,
  SandboxTemplateUploadSpec,
  SandboxTemplateUploadedFile,
  SandboxTemplateUploadRequest,
} from "./sandbox-template-local";

export async function runSandboxTemplateStart(
  options: Record<string, string | boolean>
): Promise<void> {
  const filePath = resolveSandboxTemplateFilePath(options);
  const projectPath = path.dirname(filePath);
  const source = await fs.readFile(filePath, "utf8");
  const result = validateSandboxTemplateYaml(source);
  if (!result.ok) {
    console.error(formatSandboxTemplateDiagnostics(result.diagnostics));
    process.exitCode = 1;
    return;
  }

  const manifest = result.manifest;
  const executable = resolveSandboxTemplateStartExecutable(manifest, options);
  const input = await resolveSandboxTemplateStartInput(
    manifest,
    options,
    projectPath
  );
  const repo = await resolveSandboxTemplateStartRepo(
    manifest,
    options,
    projectPath
  );
  const client = await resolveSandboxClient(options);
  const createInput = buildSandboxTemplateStartCreateInput(
    manifest,
    options,
    repo
  );
  const sandbox = await createSandboxTemplateStartSandbox(
    client,
    createInput,
    repo
  );
  await waitForSandboxTemplateRunnerReady(client, sandbox.id);
  const setupCommands = await runSandboxTemplateSetupCommands(
    client,
    sandbox.id,
    manifest,
    options
  );
  const uploadedFiles = await uploadSandboxTemplateStartFiles(
    client,
    sandbox.id,
    input.uploadRequests
  );
  const commandInput = {
    ...input.scalars,
    ...formatUploadedFileParams(uploadedFiles, input.uploadRequests),
  };
  const execution = await runSandboxTemplateExecutable(
    client,
    sandbox.id,
    executable,
    commandInput,
    sandboxTemplateRuntimeEnv(sandbox)
  );
  const previews = await openSandboxTemplatePorts(
    client,
    sandbox.id,
    executable.ports
  );
  const schedules = await createSandboxTemplateStartSchedules(
    client,
    sandbox.id,
    manifest,
    options
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        file: filePath,
        repo,
        executable: {
          kind: executable.kind,
          name: executable.name,
          command: executable.command,
        },
        sandbox: summarizeSandbox(sandbox),
        setupCommands,
        uploadedFiles,
        input: commandInput,
        execution,
        previews,
        schedules,
        expectedArtifacts: executable.artifactPaths,
      },
      null,
      2
    )
  );
}

export function resolveSandboxTemplateStartExecutable(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>
): SandboxTemplateExecutable {
  const executables = sandboxTemplateExecutableEntries(manifest);
  const action =
    typeof options.action === "string" ? options.action.trim() : "";
  const service =
    typeof options.service === "string" ? options.service.trim() : "";
  const target =
    typeof options.target === "string" ? options.target.trim() : "";
  const entrypoint =
    typeof options.entrypoint === "string" ? options.entrypoint.trim() : "";
  const requested = action || service || target || entrypoint || "start";
  const kind = action ? "action" : service ? "service" : "";
  const match = executables.find(
    (candidate) =>
      candidate.name === requested && (!kind || candidate.kind === kind)
  );
  if (!match) {
    throw new Error(
      `manifest executable not found: ${requested}. Available: ${executables
        .map((candidate) => `${candidate.kind}:${candidate.name}`)
        .join(", ")}`
    );
  }
  return match;
}

export function buildSandboxTemplateStartCreateInput(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>,
  repo: string
): SandboxCreatePlan {
  const budgetUsd =
    typeof options.budgetUsd === "string" && options.budgetUsd.trim()
      ? options.budgetUsd.trim()
      : typeof options.budget === "string" && options.budget.trim()
      ? options.budget.trim()
      : "0.05";
  const maxDurationSeconds = parseIntegerOption(
    options.maxDurationSeconds,
    "max-duration-seconds"
  );
  const idleTimeoutSeconds = parseIntegerOption(
    options.idleTimeoutSeconds,
    "idle-timeout-seconds"
  );
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
      runtimeId ||
      sandboxRuntimeProjectId ||
      sandboxRuntimeAgentId
  );
  const env = parseSandboxTemplateEnvOptions(manifest, options);
  const workloadSource = sandboxWorkloadSourceFromManifest(manifest);
  const sandbox: SandboxCreateInput = {
    repo,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
    resources: manifest.resources ?? {},
    networkPolicy: {
      internetEgress: sandboxTemplateInternetEgressPolicy(
        manifest.network.egress
      ),
    },
    budget: { maxUsd: budgetUsd },
    quotas: {
      maxSpendUsd: budgetUsd,
      ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
      ...(idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {}),
    },
    ...(env.length > 0 ? { env } : {}),
    ...(workloadSource ? { workloadSource } : {}),
    volumes: manifest.volumes,
    metadata: {
      source: "openpond-code-sandbox-template-start",
      manifestFile: OPENPOND_MANIFEST_FILE_NAME,
      template: {
        name: manifest.name,
        version: manifest.version,
        useCase: manifest.useCase,
      },
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
          },
        }
      : {}),
  };
}

function sandboxWorkloadSourceFromManifest(
  manifest: SandboxTemplateManifest
): SandboxCreateInput["workloadSource"] | undefined {
  if (manifest.runtime.image) {
    return { image: manifest.runtime.image };
  }
  if (manifest.runtime.dockerfile) {
    return { dockerfile: manifest.runtime.dockerfile };
  }
  return undefined;
}

export function sandboxTemplateInternetEgressPolicy(
  egress: SandboxTemplateManifest["network"]["egress"]
): "allow" | "block" {
  return egress === "allow" ? "allow" : "block";
}

export async function createSandboxTemplateStartSandbox(
  client: OpenPondSandboxClient,
  plan: SandboxCreatePlan,
  repo: string
): Promise<SandboxRecord> {
  const requestedAt = Date.now();
  try {
    return (await createSandboxFromPlan(client, plan)).sandbox;
  } catch (error) {
    if (!isLikelySandboxCreateTimeout(error)) {
      throw error;
    }
    console.warn(
      "warning: sandbox create timed out; checking for the created sandbox record"
    );
    return recoverTimedOutSandboxCreate(
      client,
      plan.sandbox,
      repo,
      requestedAt
    );
  }
}

export function isLikelySandboxCreateTimeout(error: unknown): boolean {
  return (
    error instanceof Error && /\b(504|timed out|timeout)\b/i.test(error.message)
  );
}

export async function recoverTimedOutSandboxCreate(
  client: OpenPondSandboxClient,
  input: SandboxCreateInput,
  repo: string,
  requestedAt: number
): Promise<SandboxRecord> {
  const timeoutMs = 12 * 60_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  const repoIdentity = normalizeSandboxTemplateRepoIdentity(repo);
  const metadata = input.metadata ?? {};
  while (Date.now() < deadline) {
    const sandboxes = await client.list({
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
    const match = sandboxes
      .filter((sandbox) => {
        if (!sandbox.repo) return false;
        if (normalizeSandboxTemplateRepoIdentity(sandbox.repo) !== repoIdentity)
          return false;
        const createdAt = Date.parse(sandbox.createdAt);
        if (Number.isFinite(createdAt) && createdAt < requestedAt - 30_000)
          return false;
        if (metadata.source && sandbox.metadata?.source !== metadata.source)
          return false;
        return true;
      })
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt)
      )[0];
    if (match?.state === "running" || match?.state === "stopped") {
      return match;
    }
    if (match?.state === "error") {
      throw new Error(
        `sandbox create failed after timeout: ${match.id}\n${match.logs.join(
          "\n"
        )}`
      );
    }
    await sleep(pollMs);
  }
  throw new Error(
    "sandbox create timed out and no matching created sandbox reached running state"
  );
}

export async function waitForSandboxTemplateRunnerReady(
  client: OpenPondSandboxClient,
  sandboxId: string
): Promise<void> {
  const timeoutMs = 120_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await client.exec(sandboxId, {
        command: "true",
        timeoutSeconds: 30,
      });
      if (
        result.command.status === "succeeded" &&
        result.command.exitCode === 0
      ) {
        return;
      }
      lastError = new Error(
        `readiness command ${result.command.status} with exit code ${String(
          result.command.exitCode
        )}`
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableSandboxRunnerReadyError(error)) {
        throw error;
      }
    }
    await sleep(pollMs);
  }
  throw new Error(
    `sandbox runner was not ready after create: ${formatUnknownError(
      lastError
    )}`
  );
}

export function isRetryableSandboxRunnerReadyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /\b(502|503|504|timed out|timeout|sandbox_not_found|sandbox_not_ready|sandbox_runner_failed)\b/i.test(
      error.message
    )
  );
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveSandboxTemplateStartInput(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>,
  projectPath: string
): Promise<{
  scalars: SandboxTemplateScalarInputs;
  uploadRequests: SandboxTemplateUploadRequest[];
}> {
  const scalars = parseSandboxTemplateScalarInputs(options);
  const uploadSpecs = collectSandboxTemplateUploadSpecs(manifest);
  const uploadRequests: SandboxTemplateUploadRequest[] = [];
  const fileInputs = parseSandboxTemplateFileInputOptions(options);
  for (const [inputName, rawValue] of Object.entries(fileInputs)) {
    const spec = uploadSpecs.get(inputName);
    if (!spec) {
      throw new Error(
        `${inputName} is not declared as a file upload input in ${OPENPOND_MANIFEST_FILE_NAME}`
      );
    }
    const localPaths = await expandSandboxTemplateUploadPaths(
      rawValue,
      projectPath
    );
    if (!spec.multiple && localPaths.length > 1) {
      throw new Error(
        `${inputName} accepts one file, got ${localPaths.length}`
      );
    }
    uploadRequests.push({ inputName, localPaths, spec });
  }

  const requiredInputs = Array.isArray(manifest.inputs.schema.required)
    ? manifest.inputs.schema.required.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  for (const inputName of requiredInputs) {
    if (
      uploadSpecs.has(inputName) &&
      !uploadRequests.some((request) => request.inputName === inputName)
    ) {
      throw new Error(
        `${inputName} is required; pass --input-file ${inputName}=<path> or --input-files ${inputName}=<glob>`
      );
    }
  }

  return { scalars, uploadRequests };
}

export function parseSandboxTemplateScalarInputs(
  options: Record<string, string | boolean>
): SandboxTemplateScalarInputs {
  const rawInputs =
    typeof options.inputs === "string"
      ? options.inputs
      : typeof options.inputJson === "string"
      ? options.inputJson
      : typeof options.params === "string"
      ? options.params
      : "";
  const scalars = rawInputs
    ? (parseJsonOption(rawInputs, "inputs") as SandboxTemplateScalarInputs)
    : {};
  if (!scalars || typeof scalars !== "object" || Array.isArray(scalars)) {
    throw new Error("inputs must be a JSON object");
  }
  const rawInput =
    typeof options.input === "string" ? options.input.trim() : "";
  if (rawInput) {
    const [name, value] = parseKeyValueOption(rawInput, "input");
    scalars[name] = value;
  }
  return scalars;
}

export function parseSandboxTemplateFileInputOptions(
  options: Record<string, string | boolean>
): Record<string, string> {
  const out: Record<string, string> = {};
  const rawFile =
    typeof options.inputFile === "string" ? options.inputFile.trim() : "";
  if (rawFile) {
    const [name, value] = parseKeyValueOption(rawFile, "input-file");
    out[name] = value;
  }
  const rawFiles =
    typeof options.inputFiles === "string" ? options.inputFiles.trim() : "";
  if (rawFiles) {
    const [name, value] = parseKeyValueOption(rawFiles, "input-files");
    out[name] = value;
  }
  return out;
}

export function parseKeyValueOption(
  value: string,
  label: string
): [string, string] {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new Error(`${label} must be formatted as name=value`);
  }
  const key = value.slice(0, index).trim();
  const raw = value.slice(index + 1).trim();
  if (!key || !raw) {
    throw new Error(`${label} must be formatted as name=value`);
  }
  return [key, raw];
}

export function collectSandboxTemplateUploadSpecs(
  manifest: SandboxTemplateManifest
): Map<string, SandboxTemplateUploadSpec> {
  const properties = asPlainRecord(manifest.inputs.schema.properties) ?? {};
  const specs = new Map<string, SandboxTemplateUploadSpec>();
  for (const [inputName, rawProperty] of Object.entries(properties)) {
    const property = asPlainRecord(rawProperty);
    if (!property) continue;
    const upload = asPlainRecord(
      property["x-openpond-upload"] ?? property.xOpenPondUpload
    );
    if (!upload) continue;
    const targetPath =
      typeof upload.targetPath === "string" && upload.targetPath.trim()
        ? normalizeSandboxUploadTargetPath(upload.targetPath)
        : "";
    if (!targetPath) {
      throw new Error(`${inputName} upload metadata is missing targetPath`);
    }
    const multiple =
      upload.multiple === true ||
      property.type === "array" ||
      asPlainRecord(property.items)?.format === "file";
    specs.set(inputName, { inputName, multiple, targetPath });
  }
  return specs;
}

export function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeSandboxUploadTargetPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/workspace\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`invalid upload target path: ${value}`);
  }
  if (normalized.split("/").some(isSandboxEnvFileName)) {
    throw new Error(
      "sandbox template uploads cannot target .env* files; create sandbox secrets and pass refs with --env-ref"
    );
  }
  return normalized;
}

export async function expandSandboxTemplateUploadPaths(
  rawValue: string,
  projectPath: string
): Promise<string[]> {
  const values = rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const paths = (
    await Promise.all(
      values.map((value) => expandSandboxTemplateUploadPath(value, projectPath))
    )
  ).flat();
  if (paths.length === 0) {
    throw new Error(`no files matched ${rawValue}`);
  }
  return paths;
}

export async function expandSandboxTemplateUploadPath(
  rawValue: string,
  projectPath: string
): Promise<string[]> {
  const absolute = path.resolve(projectPath, rawValue);
  if (!rawValue.includes("*")) {
    assertSandboxTemplateUploadPathAllowed(absolute);
    const stats = await fs.stat(absolute);
    if (!stats.isFile()) {
      throw new Error(`upload path is not a file: ${absolute}`);
    }
    return [absolute];
  }
  const directory = path.dirname(absolute);
  const basename = path.basename(absolute);
  const regex = globBasenameToRegExp(basename);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const matchingEntries = entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const blocked = matchingEntries.find((entry) =>
    isSandboxEnvFileName(entry.name)
  );
  if (blocked) {
    throw new Error(
      "sandbox template uploads cannot include .env* files; create sandbox secrets and pass refs with --env-ref"
    );
  }
  return matchingEntries
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function assertSandboxTemplateUploadPathAllowed(
  localPath: string
): void {
  if (isSandboxEnvFileName(path.basename(localPath))) {
    throw new Error(
      "sandbox template uploads cannot include .env* files; create sandbox secrets and pass refs with --env-ref"
    );
  }
}

export function isSandboxEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

export function globBasenameToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export async function runSandboxTemplateSetupCommands(
  client: OpenPondSandboxClient,
  sandboxId: string,
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>
): Promise<
  Array<{ command: string; status: string; exitCode: number | null }>
> {
  const timeoutSeconds =
    parseIntegerOption(options.setupTimeoutSeconds, "setup-timeout-seconds") ??
    900;
  const results: Array<{
    command: string;
    status: string;
    exitCode: number | null;
  }> = [];
  for (const command of manifest.setup.commands) {
    const result = await runSandboxTemplateShellCommand(
      client,
      sandboxId,
      command,
      timeoutSeconds
    );
    results.push({
      command,
      status: result.status,
      exitCode: result.exitCode,
    });
    if (result.status !== "succeeded" || result.exitCode !== 0) {
      throw new Error(`setup command failed: ${command}\n${result.output}`);
    }
  }
  return results;
}

export async function uploadSandboxTemplateStartFiles(
  client: OpenPondSandboxClient,
  sandboxId: string,
  requests: SandboxTemplateUploadRequest[]
): Promise<SandboxTemplateUploadedFile[]> {
  const uploaded: SandboxTemplateUploadedFile[] = [];
  for (const request of requests) {
    for (const localPath of request.localPaths) {
      const contents = await fs.readFile(localPath);
      const sandboxPath = joinSandboxUploadPath(
        request.spec.targetPath,
        path.basename(localPath)
      );
      await client.uploadFileBase64(
        sandboxId,
        sandboxPath,
        contents.toString("base64")
      );
      uploaded.push({
        inputName: request.inputName,
        localPath,
        sandboxPath,
        sizeBytes: contents.byteLength,
      });
    }
  }
  return uploaded;
}

export function joinSandboxUploadPath(
  targetPath: string,
  basename: string
): string {
  return `${targetPath.replace(/\/+$/, "")}/${basename.replace(/^\/+/, "")}`;
}

export function formatUploadedFileParams(
  uploadedFiles: SandboxTemplateUploadedFile[],
  requests: SandboxTemplateUploadRequest[]
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const request of requests) {
    const files = uploadedFiles
      .filter((file) => file.inputName === request.inputName)
      .map((file) => file.sandboxPath);
    out[request.inputName] = request.spec.multiple ? files : files[0] ?? "";
  }
  return out;
}

export async function runSandboxTemplateExecutable(
  client: OpenPondSandboxClient,
  sandboxId: string,
  executable: SandboxTemplateExecutable,
  input: SandboxTemplateScalarInputs,
  env: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  await uploadSandboxTemplateReplayParams(client, sandboxId, input);
  const command = formatSandboxTemplateCommand(executable, env);
  const timeoutSeconds = executable.timeoutSeconds;
  if (executable.kind === "service") {
    const result = await client.startProcess(sandboxId, {
      command,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
    return { kind: "service", process: result.process };
  }
  const result = await runSandboxTemplateProcessToCompletion(
    client,
    sandboxId,
    command,
    timeoutSeconds ?? 900
  );
  if (result.status !== "succeeded" || result.exitCode !== 0) {
    throw new Error(
      `template command failed: ${executable.name}\n${result.output}`
    );
  }
  return { kind: executable.kind, process: result };
}

export async function runSandboxTemplateShellCommand(
  client: OpenPondSandboxClient,
  sandboxId: string,
  command: string,
  timeoutSeconds?: number
): Promise<{
  command: string;
  status: string;
  output: string;
  exitCode: number | null;
}> {
  return runSandboxTemplateProcessToCompletion(
    client,
    sandboxId,
    command,
    timeoutSeconds ?? 900
  );
}

export async function uploadSandboxTemplateReplayParams(
  client: OpenPondSandboxClient,
  sandboxId: string,
  input: SandboxTemplateScalarInputs
): Promise<void> {
  const paramsJson = `${JSON.stringify({ input }, null, 2)}\n`;
  await client.uploadFileBase64(
    sandboxId,
    "openpond-replay-params.json",
    Buffer.from(paramsJson, "utf8").toString("base64")
  );
}

export async function runSandboxTemplateProcessToCompletion(
  client: OpenPondSandboxClient,
  sandboxId: string,
  command: string,
  timeoutSeconds: number
): Promise<{
  command: string;
  status: string;
  output: string;
  exitCode: number | null;
  processId: string;
}> {
  const started = await client.startProcess(sandboxId, {
    command,
    timeoutSeconds,
  });
  let current = started.process;
  const deadline = Date.now() + timeoutSeconds * 1000 + 30_000;
  while (current.status === "running" && Date.now() < deadline) {
    await sleep(3_000);
    const polled = await client.getProcess(sandboxId, current.id);
    current = polled.process;
  }
  return {
    command: current.command,
    status: current.status,
    output: current.output,
    exitCode: current.exitCode,
    processId: current.id,
  };
}

export function sandboxTemplateRuntimeEnv(
  sandbox: SandboxRecord
): Record<string, string> {
  return {
    OPENPOND_SANDBOX_ID: sandbox.id,
    ...(sandbox.runtimeId
      ? { OPENPOND_SANDBOX_RUNTIME_ID: sandbox.runtimeId }
      : {}),
  };
}

export function formatSandboxTemplateCommand(
  executable: SandboxTemplateExecutable,
  env: Record<string, string> = {}
): string {
  const paramsPath = quoteShellArg(replayParamsPathForExecutable(executable));
  const envPrefix = `OPENPOND_REPLAY_PARAMS_BASE64="$(base64 -w0 ${paramsPath} 2>/dev/null || base64 ${paramsPath} | tr -d '\\n')"`;
  const runtimeEnvPrefix = Object.entries(env)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${quoteShellArg(value)}`)
    .join(" ");
  const command = [runtimeEnvPrefix, envPrefix, executable.command]
    .filter(Boolean)
    .join(" ");
  if (!executable.cwd) return command;
  return `cd ${quoteShellArg(executable.cwd)} && ${command}`;
}

export function replayParamsPathForExecutable(
  executable: SandboxTemplateExecutable
): string {
  if (!executable.cwd) return "openpond-replay-params.json";
  const cwd = executable.cwd.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
  return (
    path.posix.relative(cwd, "openpond-replay-params.json") ||
    "openpond-replay-params.json"
  );
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function openSandboxTemplatePorts(
  client: OpenPondSandboxClient,
  sandboxId: string,
  ports: SandboxTemplatePort[]
): Promise<Array<Record<string, unknown>>> {
  const previews: Array<Record<string, unknown>> = [];
  for (const port of ports) {
    const result = await client.openPort(sandboxId, {
      port: port.port,
      ...(port.label ? { label: port.label } : {}),
      access: port.access,
      autoStart: false,
    });
    previews.push(result.preview as unknown as Record<string, unknown>);
  }
  return previews;
}

export function resolveSandboxTemplateFilePath(
  options: Record<string, string | boolean>
): string {
  const rawFile =
    typeof options.file === "string" && options.file.trim().length > 0
      ? options.file.trim()
      : typeof options.manifest === "string" &&
        options.manifest.trim().length > 0
      ? options.manifest.trim()
      : OPENPOND_MANIFEST_FILE_NAME;
  return path.resolve(process.cwd(), rawFile);
}

export function resolveSandboxTemplateScaffoldPath(
  options: Record<string, string | boolean>
): string {
  const rawPath =
    typeof options.path === "string" && options.path.trim().length > 0
      ? options.path.trim()
      : typeof options.dir === "string" && options.dir.trim().length > 0
      ? options.dir.trim()
      : process.cwd();
  return path.resolve(process.cwd(), rawPath);
}
