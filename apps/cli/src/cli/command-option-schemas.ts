const boolean = "boolean" as const;
const integer = "integer" as const;
const json = "json" as const;
const number = "number" as const;
const string = "string" as const;

export const CHAT_OPTION_SCHEMA = {
  approvalPolicy: string, cwd: string, json: boolean, maxOutputBytes: integer,
  message: string, messageFile: string, model: string, noServerStart: boolean,
  nonInteractive: boolean, project: string, provider: string, sandbox: string,
  server: string, stdin: boolean, timeoutSec: integer, yes: boolean,
} as const;

export const SANDBOX_OPTION_SCHEMA = {
  access: string, agentId: string, all: boolean, artifactPaths: string,
  async: boolean, authHeader: string, authHeaderValue: string, authToken: string,
  autoStart: boolean, baseRef: string, branch: string, budget: number,
  budgetUsd: number, cleanup: boolean, cols: integer, command: string,
  content: string, contentBase64: string, contents: string, contentsBase64: string,
  cpu: number, create: boolean, description: string, diskGb: number,
  dockerBuildArgs: json, dockerRegistrySecretRefs: string, dockerfile: string,
  dockerfileContext: string, dockerfileTarget: string, domain: string,
  envLiteral: string, envName: string, envRef: string, expectedMppMode: string,
  expectedVersion: integer, failOnUnpreservedChanges: boolean, ffOnly: boolean,
  forceWithLease: boolean, fork: boolean, fromPath: string, idempotencyKey: string,
  idleTimeoutSeconds: integer, image: string, imageDigest: string, input: string,
  inputBase64: string, integrationCapabilities: string, integrationConnection: string,
  integrationScopes: string, intervalMs: integer, json: boolean, keep: boolean,
  label: string, leaseId: string, lifecycleHint: json, manifestPath: string,
  maxDurationSeconds: integer, maxEntries: number, maxResults: number,
  memoryGb: number, message: string, name: string, noPreview: boolean,
  overwrite: boolean, params: json, path: string, paths: string, payload: json,
  port: integer, preview: boolean, projectId: string, publish: boolean, q: string,
  query: string, rebase: boolean, recursive: boolean, registrySecretRef: string,
  remote: string, replayState: string, repo: string, respondAsync: boolean,
  rows: integer, runtimeAgentId: string, runtimeBaseBranch: string,
  runtimeBaseSha: string, runtimeId: string, runtimeProfileId: string,
  runtimeProjectId: string, runtimePromotionPolicy: string, runtimeWorkspaceRoot: string,
  sandboxId: string, scope: string, since: integer, snapshot: boolean,
  snapshotId: string, sourceProjectId: string, sourceRepoUrl: string,
  sourceSandboxId: string, startPoint: string, status: string, stdin: boolean,
  summary: boolean, tag: string, tags: string, targetId: string, targetType: string,
  teamId: string, templateName: string, templateVersion: string,
  templateVisibility: string, timeoutSeconds: integer, toPath: string, type: string,
  useCase: string, validationCommand: string, value: string, version: string,
  volumeDeleteOnSandboxDelete: boolean, volumeMountPath: string, volumeName: string,
  volumeStorageGb: number, workflowMode: string,
} as const;

export const SANDBOX_TEMPLATE_OPTION_SCHEMA = {
  action: string, agentId: string, budget: number, budgetUsd: number,
  build: string, branch: string, commit: boolean, commitMessage: string,
  description: string, dir: string, disableSchedule: string, disableSchedules: string,
  enableSchedule: string, enableSchedules: string, entrypoint: string, env: json,
  envRef: string,
  file: string, force: boolean, idleTimeoutSeconds: integer, inherit: boolean,
  input: json, inputFile: string, inputFiles: string, inputJson: json, inputs: json,
  json: boolean, keepTokenRemote: boolean, manifest: string,
  maxDurationSeconds: integer, name: string, noPush: boolean, noWrite: boolean,
  out: string, outDir: string, output: string, outputDir: string, params: json,
  path: string, plan: string, projectId: string, repo: string,
  runtimeAgentId: string, runtimeBaseBranch: string, runtimeBaseSha: string,
  runtimeId: string, runtimeProjectId: string, runtimePromotionPolicy: string,
  scheduleMode: string, scheduleOverride: json, scheduleOverrides: json,
  schedules: string, service: string, setRemoteToken: boolean,
  setupTimeoutSeconds: integer, target: string, teamId: string,
  timeoutSeconds: integer, token: string, workflowMode: string, yes: boolean,
} as const;

export const PROJECT_OPTION_SCHEMA = {
  branch: string, commitMessage: string, defaultBranch: string, description: string,
  gitOwner: string, gitRepo: string, internalRepoPath: string, json: boolean,
  name: string, path: string, projectId: string, repo: string,
  sourceCheckDispatch: string, sourceType: string, teamId: string,
  templateRepoUrl: string,
} as const;

export const AGENT_OPTION_SCHEMA = {
  agentId: string, agentEdit: json, allowLatestSource: boolean,
  attachmentsJson: json, baseSha: string, chatMode: string, checkKind: string,
  conversationId: string, cwd: string, dispatch: string, entrypointName: string,
  entrypointScope: string, expectedManifestHash: string,
  evalStatus: string, expectedSourceCommitSha: string, idempotencyKey: string, input: json,
  inputFile: string, json: boolean, limit: integer, message: string, metadata: json,
  name: string, path: string, payload: json, projectId: string, prompt: string,
  publishedSnapshotId: string, ref: string, requirePublishedSnapshot: boolean,
  requiredEnv: string, requiredIntegrations: string, runtimePromotionPolicy: string,
  runtimeSourceMode: string, sourceCheckDispatch: string, sourceMode: string,
  sourceRef: string, status: string, targetProjectId: string, teamId: string,
  triggerType: string, workItemId: string, workflowMode: string,
} as const;
