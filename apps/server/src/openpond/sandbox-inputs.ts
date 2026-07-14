import type {
  SandboxRuntimeCreateInput,
  SandboxRuntimeSandboxCreateInput,
  SandboxCreateInput,
  SandboxExecInput,
  SandboxFileDownloadInput,
  SandboxForkInput,
  SandboxGitBranchInput,
  SandboxGitCommitInput,
  SandboxGitPullInput,
  SandboxGitPushInput,
  SandboxIntegrationConnectionLeaseInput,
  SandboxIntegrationConnectionStatusFilter,
  SandboxOpenPortInput,
  SandboxProcessStartInput,
  SandboxPtyInput,
  SandboxPtyStartInput,
  SandboxReplayInput,
  SandboxSnapshotInput,
  SandboxTemplateBuildCreateInput,
  SandboxTemplateLaunchInput,
  SandboxSnapshotValidateInput,
  SandboxSnapshotUpdateInput,
  SandboxEnvVarInput,
} from "@openpond/cloud";
import {
  connectedAppBundleByProvider,
  normalizeConnectedAppProviderFamilyId,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
} from "@openpond/contracts";
import { pipefailSandboxShellCommand } from "./shell-command.js";

type SandboxRuntimeIntegrationLease = NonNullable<SandboxCreateInput["integrationLeases"]>[number];

export function normalizeOptionalUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const UI_PURPOSE_METADATA_KEYS = ["workspacePurpose", "purpose"] as const;

export function sanitizeCreateMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = { ...(value as Record<string, unknown>) };
  for (const key of UI_PURPOSE_METADATA_KEYS) {
    delete metadata[key];
  }
  return metadata;
}

export function sanitizeSandboxRuntimeInput(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const runtime = { ...(value as Record<string, unknown>) };
  for (const key of UI_PURPOSE_METADATA_KEYS) {
    delete runtime[key];
  }
  const metadata = sanitizeCreateMetadata(runtime.metadata);
  if (metadata) {
    runtime.metadata = metadata;
  } else {
    delete runtime.metadata;
  }
  return runtime;
}

export function normalizeCreateInput(payload: unknown): SandboxCreateInput {
  const input = asRecord(payload);
  if (input.sandboxRuntime) {
    throw new Error(
      "Sandbox runtime settings must use /v1/runtimes before materializing a sandbox.",
    );
  }
  const out: SandboxCreateInput = {};
  if (typeof input.repo === "string" && input.repo.trim()) out.repo = input.repo.trim();
  if (typeof input.teamId === "string" && input.teamId.trim()) out.teamId = input.teamId.trim();
  if (typeof input.projectId === "string" && input.projectId.trim()) {
    (out as Record<string, unknown>).projectId = input.projectId.trim();
  }
  if (typeof input.agentId === "string" && input.agentId.trim()) {
    (out as Record<string, unknown>).agentId = input.agentId.trim();
  }
  if (typeof input.command === "string" && input.command.trim()) out.command = input.command.trim();
  if (typeof input.runtimeProfileId === "string" && input.runtimeProfileId.trim()) {
    (out as Record<string, unknown>).runtimeProfileId = input.runtimeProfileId.trim();
  }
  if (input.workloadSource && typeof input.workloadSource === "object" && !Array.isArray(input.workloadSource)) {
    (out as Record<string, unknown>).workloadSource = input.workloadSource;
  }
  if (input.sourceArchive && typeof input.sourceArchive === "object" && !Array.isArray(input.sourceArchive)) {
    (out as Record<string, unknown>).sourceArchive = input.sourceArchive;
  }
  if (input.visibility === "private" || input.visibility === "team") {
    out.visibility = input.visibility;
  }
  if (input.resources && typeof input.resources === "object" && !Array.isArray(input.resources)) {
    out.resources = input.resources as SandboxCreateInput["resources"];
  }
  if (input.budget && typeof input.budget === "object" && !Array.isArray(input.budget)) {
    out.budget = input.budget as SandboxCreateInput["budget"];
  }
  if ("env" in input) {
    out.env = normalizeSandboxEnvRefsForApp(input.env);
  }
  if (input.networkPolicy && typeof input.networkPolicy === "object" && !Array.isArray(input.networkPolicy)) {
    out.networkPolicy = input.networkPolicy as SandboxCreateInput["networkPolicy"];
  }
  if (input.quotas && typeof input.quotas === "object" && !Array.isArray(input.quotas)) {
    out.quotas = input.quotas as SandboxCreateInput["quotas"];
  }
  if (Array.isArray(input.volumes)) {
    out.volumes = input.volumes as SandboxCreateInput["volumes"];
  }
  if ("integrationLeases" in input) {
    out.integrationLeases = normalizeIntegrationLeaseRefsForRuntime(input.integrationLeases);
  }
  if (Array.isArray(input.integrationConnectionLeases)) {
    out.integrationConnectionLeases =
      input.integrationConnectionLeases as SandboxCreateInput["integrationConnectionLeases"];
  }
  const metadata = sanitizeCreateMetadata(input.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

export function normalizeSandboxRuntimeCreateInput(
  payload: unknown,
): SandboxRuntimeCreateInput {
  const input = asRecord(payload);
  const runtime = sanitizeSandboxRuntimeInput(input) ?? {};
  const out: SandboxRuntimeCreateInput = {};
  if (typeof runtime.teamId === "string" && runtime.teamId.trim()) {
    out.teamId = runtime.teamId.trim();
  }
  if (typeof runtime.projectId === "string" && runtime.projectId.trim()) {
    (out as Record<string, unknown>).projectId = runtime.projectId.trim();
  }
  if (typeof runtime.agentId === "string" && runtime.agentId.trim()) {
    (out as Record<string, unknown>).agentId = runtime.agentId.trim();
  }
  if (typeof runtime.workflowMode === "string" && runtime.workflowMode.trim()) {
    out.workflowMode =
      runtime.workflowMode.trim() as SandboxRuntimeCreateInput["workflowMode"];
  } else if (typeof runtime.mode === "string" && runtime.mode.trim()) {
    out.workflowMode =
      runtime.mode.trim() as SandboxRuntimeCreateInput["workflowMode"];
  }
  if (typeof runtime.baseBranch === "string" && runtime.baseBranch.trim()) {
    out.baseBranch = runtime.baseBranch.trim();
  }
  if (typeof runtime.baseSha === "string" && runtime.baseSha.trim()) {
    out.baseSha = runtime.baseSha.trim();
  }
  if (typeof runtime.sandboxId === "string" && runtime.sandboxId.trim()) {
    out.sandboxId = runtime.sandboxId.trim();
  }
  if (
    typeof runtime.rootfsSnapshotId === "string" &&
    runtime.rootfsSnapshotId.trim()
  ) {
    out.rootfsSnapshotId = runtime.rootfsSnapshotId.trim();
  }
  if (
    typeof runtime.dependencySnapshotId === "string" &&
    runtime.dependencySnapshotId.trim()
  ) {
    out.dependencySnapshotId = runtime.dependencySnapshotId.trim();
  }
  if (
    typeof runtime.runtimeProfileId === "string" &&
    runtime.runtimeProfileId.trim()
  ) {
    out.runtimeProfileId =
      runtime.runtimeProfileId.trim() as SandboxRuntimeCreateInput["runtimeProfileId"];
  }
  if (
    typeof runtime.promotionPolicy === "string" &&
    runtime.promotionPolicy.trim()
  ) {
    out.promotionPolicy =
      runtime.promotionPolicy.trim() as SandboxRuntimeCreateInput["promotionPolicy"];
  }
  if (
    runtime.metadata &&
    typeof runtime.metadata === "object" &&
    !Array.isArray(runtime.metadata)
  ) {
    out.metadata = runtime.metadata as Record<string, unknown>;
  }
  return out;
}

export function normalizeSandboxRuntimeSandboxCreateInput(
  payload: unknown,
): SandboxRuntimeSandboxCreateInput {
  return normalizeCreateInput(payload) as SandboxRuntimeSandboxCreateInput;
}

export function normalizeSnapshotCreateInput(payload: unknown): SandboxSnapshotInput {
  return asRecord(payload) as SandboxSnapshotInput;
}

export function normalizeSandboxListInput(payload: unknown): {
  teamId?: string;
  projectId?: string;
  agentId?: string;
} {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  return {
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

export function normalizeReplayStartInput(payload: unknown): SandboxReplayInput & { teamId?: string; projectId?: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const {
    teamId: _teamId,
    projectId: _projectId,
    appId: _appId,
    ...body
  } = input;
  const out = body as SandboxReplayInput & { teamId?: string; projectId?: string };
  if (teamId) out.teamId = teamId;
  if (projectId) out.projectId = projectId;
  return out;
}

export function normalizeIntegrationStatusFilter(
  value: unknown,
): SandboxIntegrationConnectionStatusFilter | undefined {
  if (
    value === "active" ||
    value === "revoked" ||
    value === "error" ||
    value === "all"
  ) {
    return value;
  }
  return undefined;
}

export function normalizeIntegrationAttachInput(
  payload: unknown,
): SandboxIntegrationConnectionLeaseInput {
  const input = asRecord(payload);
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) {
    throw new Error("Sandbox integration connection is required.");
  }
  const capabilities = normalizeStringArray(input.capabilities);
  if (capabilities.length === 0) {
    throw new Error("Sandbox integration capabilities are required.");
  }
  validateIntegrationCapabilitiesForProvider(input.provider, capabilities);
  const scopes = normalizeOptionalStringArray(input.scopes, "Sandbox integration scopes");
  const expiresAt = normalizeIntegrationExpiresAt(input.expiresAt);
  const ttlSeconds = normalizeIntegrationTtlSeconds(input.ttlSeconds);
  const resourcePolicy = normalizeIntegrationResourcePolicy(input.resourcePolicy);
  return {
    connectionId,
    capabilities,
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(resourcePolicy ? { resourcePolicy } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(typeof input.required === "boolean" ? { required: input.required } : {}),
  };
}

export function normalizeIntegrationLeaseRefsForRuntime(value: unknown): SandboxRuntimeIntegrationLease[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Sandbox integration leases must be an array.");
  }
  return value.map((item) => normalizeIntegrationLeaseRefForRuntime(item));
}

export function normalizeIntegrationLeaseRefForRuntime(value: unknown): SandboxRuntimeIntegrationLease {
  const input = asRecord(value);
  const leaseId = typeof input.leaseId === "string" ? input.leaseId.trim() : "";
  if (!leaseId) {
    throw new Error("Sandbox integration leaseId is required.");
  }
  if ("connectionId" in input) {
    throw new Error("Sandbox integration leases must use leaseId/proxy refs, not connection ids.");
  }
  assertNoSensitiveIntegrationLeaseKeys(input);
  const provider = normalizeLeaseableIntegrationProvider(input.provider);
  const capabilities = normalizeStringArray(input.capabilities);
  if (capabilities.length === 0) {
    throw new Error("Sandbox integration lease capabilities are required.");
  }
  validateIntegrationCapabilitiesForProvider(provider, capabilities);
  const scopes = normalizeOptionalStringArray(input.scopes, "Sandbox integration lease scopes");
  const resourcePolicy = normalizeIntegrationResourcePolicy(input.resourcePolicy);
  const expiresAt = normalizeIntegrationExpiresAt(input.expiresAt);
  const proxyUrl = typeof input.proxyUrl === "string" ? input.proxyUrl.trim() : "";
  return {
    leaseId,
    provider,
    capabilities,
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(resourcePolicy ? { resourcePolicy } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(typeof input.required === "boolean" ? { required: input.required } : {}),
  };
}

export function normalizeLeaseableIntegrationProvider(value: unknown): SandboxRuntimeIntegrationLease["provider"] {
  if (typeof value !== "string") {
    throw new Error("Sandbox integration lease provider is required.");
  }
  const provider = normalizeConnectedAppProviderFamilyId(value);
  if (!provider) {
    throw new Error(`Sandbox integration provider is not supported: ${value}`);
  }
  const bundle = connectedAppBundleByProvider(provider);
  if (!bundle?.leasePolicy.leaseable) {
    throw new Error(`Sandbox integration provider is not leaseable: ${provider}`);
  }
  return provider as SandboxRuntimeIntegrationLease["provider"];
}

export function assertNoSensitiveIntegrationLeaseKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (isSensitivePolicyKey(key)) {
      throw new Error("Sandbox integration leases must not include secrets or credentials.");
    }
  }
}

export function validateIntegrationCapabilitiesForProvider(providerValue: unknown, capabilities: string[]): void {
  if (providerValue === undefined || providerValue === null || providerValue === "") {
    return;
  }
  if (typeof providerValue !== "string") {
    throw new Error("Sandbox integration provider must be a string.");
  }
  const provider = normalizeConnectedAppProviderFamilyId(providerValue);
  if (!provider) {
    throw new Error(`Sandbox integration provider is not supported: ${providerValue}`);
  }
  const bundle = connectedAppBundleByProvider(provider);
  if (!bundle?.leasePolicy.leaseable) {
    throw new Error(`Sandbox integration provider is not leaseable: ${provider}`);
  }
  const allowedCapabilities = new Set(bundle.leasePolicy.allowedCapabilityIds);
  const deniedCapabilities = capabilities.filter((capability) => !allowedCapabilities.has(capability));
  if (deniedCapabilities.length > 0) {
    throw new Error(
      `Sandbox integration capabilities are not allowed for ${provider}: ${deniedCapabilities.join(", ")}`,
    );
  }
}

export function normalizeIntegrationLeaseId(payload: unknown): string {
  const input = asRecord(payload);
  const leaseId = typeof input.leaseId === "string" ? input.leaseId.trim() : "";
  if (!leaseId) {
    throw new Error("Sandbox integration lease is required.");
  }
  return leaseId;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

export function normalizeOptionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`${label} must not contain empty values.`);
    }
    return trimmed;
  });
}

export function normalizeIntegrationTtlSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const ttlSeconds = Number(value);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Sandbox integration ttlSeconds must be a positive number.");
  }
  return Math.max(1, Math.floor(ttlSeconds));
}

export function normalizeIntegrationExpiresAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error("Sandbox integration expiresAt must be an ISO timestamp string.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error("Sandbox integration expiresAt must be a valid ISO timestamp.");
  }
  return trimmed;
}

export function normalizeIntegrationResourcePolicy(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandbox integration resourcePolicy must be an object.");
  }
  assertNoSensitiveResourcePolicyKeys(value, []);
  const serialized = JSON.stringify(value);
  if (serialized.length > 16 * 1024) {
    throw new Error("Sandbox integration resourcePolicy is too large.");
  }
  return value as Record<string, unknown>;
}

export function assertNoSensitiveResourcePolicyKeys(value: unknown, path: string[]): void {
  if (!value || typeof value !== "object") return;
  if (path.length > 8) {
    throw new Error("Sandbox integration resourcePolicy is too deeply nested.");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveResourcePolicyKeys(item, path);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitivePolicyKey(key)) {
      throw new Error("Sandbox integration resourcePolicy must not include secrets or credentials.");
    }
    assertNoSensitiveResourcePolicyKeys(child, [...path, key]);
  }
}

export function isSensitivePolicyKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("idtoken") ||
    normalized.includes("oauth") ||
    normalized.includes("bearer") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

export function normalizeExecInput(payload: unknown): SandboxExecInput {
  const input = asRecord(payload);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("Sandbox command is required.");
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)
      ? Math.max(1, Math.floor(input.timeoutSeconds))
      : undefined;
  const pipefailCommand = pipefailSandboxShellCommand(command);
  return timeoutSeconds ? { command: pipefailCommand, timeoutSeconds } : { command: pipefailCommand };
}

export function normalizeProcessStartInput(payload: unknown): SandboxProcessStartInput {
  const input = asRecord(payload);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("Sandbox process command is required.");
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)
      ? Math.max(1, Math.floor(input.timeoutSeconds))
      : undefined;
  return timeoutSeconds ? { command, timeoutSeconds } : { command };
}

export function normalizePtyStartInput(payload: unknown): SandboxPtyStartInput {
  const input = asRecord(payload);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)
      ? Math.max(1, Math.floor(input.timeoutSeconds))
      : undefined;
  const rows =
    typeof input.rows === "number" && Number.isFinite(input.rows)
      ? Math.max(1, Math.floor(input.rows))
      : undefined;
  const cols =
    typeof input.cols === "number" && Number.isFinite(input.cols)
      ? Math.max(1, Math.floor(input.cols))
      : undefined;
  return {
    ...(command ? { command } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
    ...(rows ? { rows } : {}),
    ...(cols ? { cols } : {}),
  };
}

export function normalizePtyInput(payload: unknown): SandboxPtyInput {
  const input = asRecord(payload);
  const dataBase64 = typeof input.dataBase64 === "string" ? input.dataBase64.trim() : "";
  if (!dataBase64) {
    throw new Error("Sandbox PTY input is required.");
  }
  return { dataBase64 };
}

export function normalizeProcessCursorInput(payload: unknown) {
  const input = asRecord(payload);
  const since = Number(input.since);
  return Number.isFinite(since) ? { since: Math.max(0, Math.floor(since)) } : {};
}

export function normalizeOpenPortInput(payload: unknown): SandboxOpenPortInput {
  const input = asRecord(payload);
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  if (
    !Number.isInteger(port) ||
    port < SANDBOX_TEMPLATE_PREVIEW_PORT_MIN ||
    port > SANDBOX_TEMPLATE_PREVIEW_PORT_MAX
  ) {
    throw new Error(
      `Sandbox preview port must be between ${SANDBOX_TEMPLATE_PREVIEW_PORT_MIN} and ${SANDBOX_TEMPLATE_PREVIEW_PORT_MAX}.`,
    );
  }
  const label =
    typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
  const access =
    input.access === "public" || input.access === "private" ? input.access : undefined;
  const autoStart = input.autoStart === true;
  const customDomain =
    typeof input.customDomain === "string" && input.customDomain.trim()
      ? input.customDomain.trim()
      : undefined;
  const out: SandboxOpenPortInput = {
    port,
    ...(label ? { label } : {}),
    ...(access ? { access } : {}),
    ...(autoStart ? { autoStart } : {}),
    ...(customDomain ? { customDomain } : {}),
  };
  if (input.cors && typeof input.cors === "object" && !Array.isArray(input.cors)) {
    out.cors = input.cors as SandboxOpenPortInput["cors"];
  }
  if (
    input.headerPolicy &&
    typeof input.headerPolicy === "object" &&
    !Array.isArray(input.headerPolicy)
  ) {
    out.headerPolicy = input.headerPolicy as SandboxOpenPortInput["headerPolicy"];
  }
  if (
    input.authPolicy &&
    typeof input.authPolicy === "object" &&
    !Array.isArray(input.authPolicy)
  ) {
    out.authPolicy = input.authPolicy as SandboxOpenPortInput["authPolicy"];
  }
  return out;
}

export function normalizeSnapshotUpdateInput(payload: unknown): SandboxSnapshotUpdateInput {
  const input = asRecord(payload);
  const out: SandboxSnapshotUpdateInput = {};
  if (input.template && typeof input.template === "object" && !Array.isArray(input.template)) {
    const template = asRecord(input.template);
    const nextTemplate: NonNullable<SandboxSnapshotUpdateInput["template"]> = {};
    if (typeof template.description === "string") {
      nextTemplate.description = template.description.trim();
    } else if (template.description === null) {
      nextTemplate.description = null;
    }
    if (Array.isArray(template.tags)) {
      nextTemplate.tags = template.tags
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 20);
    }
    if (template.visibility === "private" || template.visibility === "team") {
      nextTemplate.visibility = template.visibility;
    }
    if (typeof template.useCase === "string") {
      nextTemplate.useCase = template.useCase.trim();
    } else if (template.useCase === null) {
      nextTemplate.useCase = null;
    }
    if (Object.keys(nextTemplate).length > 0) {
      out.template = nextTemplate;
    }
  }
  if (input.retention && typeof input.retention === "object" && !Array.isArray(input.retention)) {
    const retention = asRecord(input.retention);
    const nextRetention: NonNullable<SandboxSnapshotUpdateInput["retention"]> = {};
    if (
      retention.class === "ephemeral" ||
      retention.class === "cached" ||
      retention.class === "pinned"
    ) {
      nextRetention.class = retention.class;
    }
    if (retention.ttlSeconds === null) {
      nextRetention.ttlSeconds = null;
    } else if (typeof retention.ttlSeconds === "number" && Number.isFinite(retention.ttlSeconds)) {
      nextRetention.ttlSeconds = Math.max(1, Math.floor(retention.ttlSeconds));
    }
    if (Object.keys(nextRetention).length > 0) {
      out.retention = nextRetention;
    }
  }
  if (!out.template && !out.retention) {
    throw new Error("Snapshot update requires template or retention changes.");
  }
  return out;
}

export function normalizeSnapshotValidateInput(payload: unknown): SandboxSnapshotValidateInput {
  const input = asRecord(payload);
  const cleanup = typeof input.cleanup === "string" ? input.cleanup.trim() : "";
  if (cleanup === "delete" || cleanup === "stop" || cleanup === "archive") {
    return { cleanup };
  }
  return {};
}

export function normalizeForkInput(payload: unknown): SandboxForkInput {
  const input = asRecord(payload);
  const out: SandboxForkInput = {};
  if (typeof input.snapshotId === "string" && input.snapshotId.trim()) {
    out.snapshotId = input.snapshotId.trim();
  }
  if (input.visibility === "private" || input.visibility === "team") {
    out.visibility = input.visibility;
  }
  if (input.resources && typeof input.resources === "object" && !Array.isArray(input.resources)) {
    out.resources = input.resources as SandboxForkInput["resources"];
  }
  if (input.budget && typeof input.budget === "object" && !Array.isArray(input.budget)) {
    out.budget = input.budget as SandboxForkInput["budget"];
  }
  if (input.networkPolicy && typeof input.networkPolicy === "object" && !Array.isArray(input.networkPolicy)) {
    out.networkPolicy = input.networkPolicy as SandboxForkInput["networkPolicy"];
  }
  if (input.quotas && typeof input.quotas === "object" && !Array.isArray(input.quotas)) {
    out.quotas = input.quotas as SandboxForkInput["quotas"];
  }
  if (Array.isArray(input.volumes)) {
    out.volumes = input.volumes as SandboxForkInput["volumes"];
  }
  if ("integrationLeases" in input) {
    out.integrationLeases = normalizeIntegrationLeaseRefsForRuntime(input.integrationLeases);
  }
  if ("env" in input) {
    out.env = normalizeSandboxEnvRefsForApp(input.env) as SandboxForkInput["env"];
  }
  if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
    out.metadata = input.metadata as Record<string, unknown>;
  }
  return out;
}

export function normalizeSandboxEnvRefsForApp(value: unknown): SandboxEnvVarInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Sandbox env must be an array.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Sandbox env entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    if ("value" in record) {
      throw new Error("Sandbox env entries must use secretRef, not inline values.");
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const secretRef = typeof record.secretRef === "string" ? record.secretRef.trim() : "";
    if (!name || !secretRef) {
      throw new Error("Sandbox env entries require name and secretRef.");
    }
    return { name, secretRef };
  });
}

export function normalizeSnapshotForkInput(
  payload: unknown,
): SandboxForkInput & { teamId?: string; projectId?: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  return {
    ...normalizeForkInput(payload),
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export function normalizeTemplateLaunchInput(
  payload: unknown,
): SandboxTemplateLaunchInput & { teamId?: string; projectId?: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const snapshotId = typeof input.snapshotId === "string" ? input.snapshotId.trim() : "";
  const templateName =
    typeof input.templateName === "string" ? input.templateName.trim() : "";
  const version = typeof input.version === "string" ? input.version.trim() : "";
  const useCase = typeof input.useCase === "string" ? input.useCase.trim() : "";
  if (!snapshotId && !templateName && !useCase) {
    throw new Error("Sandbox template launch requires snapshotId, templateName, or useCase.");
  }
  return {
    ...normalizeForkInput(payload),
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    ...(templateName ? { templateName } : {}),
    ...(version ? { version } : {}),
    ...(useCase ? { useCase } : {}),
  };
}

export function normalizeTemplateBuildListInput(payload: unknown): { teamId: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  if (!teamId) {
    throw new Error("Template build team ID is required.");
  }
  return { teamId };
}

export function normalizeTemplateBuildCreateInput(payload: unknown): SandboxTemplateBuildCreateInput {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const sourceRepoUrl = typeof input.sourceRepoUrl === "string" ? input.sourceRepoUrl.trim() : "";
  const sourceProjectId = typeof input.sourceProjectId === "string" ? input.sourceProjectId.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const manifestPath = typeof input.manifestPath === "string" ? input.manifestPath.trim() : "";
  if (!teamId) {
    throw new Error("Template build team ID is required.");
  }
  if (!sourceRepoUrl && !sourceProjectId) {
    throw new Error("Template build source repo or source project is required.");
  }
  return {
    teamId,
    ...(sourceRepoUrl ? { sourceRepoUrl } : {}),
    ...(sourceProjectId ? { sourceProjectId } : {}),
    ...(branch ? { branch } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(typeof input.publish === "boolean" ? { publish: input.publish } : {}),
  };
}

export function normalizeListFilesInput(payload: unknown) {
  const input = asRecord(payload);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const maxEntries = Number(input.maxEntries);
  return {
    ...(path ? { path } : {}),
    ...(typeof input.recursive === "boolean" ? { recursive: input.recursive } : {}),
    ...(Number.isFinite(maxEntries) ? { maxEntries } : {}),
  };
}

export function normalizeSearchFilesInput(payload: unknown) {
  const input = asRecord(payload);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    throw new Error("Sandbox file search query is required.");
  }
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const maxResults = Number(input.maxResults);
  return {
    query,
    ...(path ? { path } : {}),
    ...(Number.isFinite(maxResults) ? { maxResults } : {}),
  };
}

export function normalizeDeleteFileInput(payload: unknown) {
  const input = asRecord(payload);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path) {
    throw new Error("Sandbox file path is required.");
  }
  return {
    path,
    recursive: typeof input.recursive === "boolean" ? input.recursive : undefined,
  };
}

export function normalizeDownloadFileInput(payload: unknown): SandboxFileDownloadInput {
  const input = normalizeDeleteFileInput(payload);
  const raw = asRecord(payload);
  const offsetBytes = Number(raw.offsetBytes);
  const maxBytes = Number(raw.maxBytes);
  return {
    path: input.path,
    ...(Number.isFinite(offsetBytes) ? { offsetBytes } : {}),
    ...(Number.isFinite(maxBytes) ? { maxBytes } : {}),
  };
}

export function normalizeUploadFileInput(payload: unknown) {
  const input = asRecord(payload);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const contents = typeof input.contents === "string" ? input.contents : "";
  const contentsBase64 = typeof input.contentsBase64 === "string" ? input.contentsBase64.trim() : "";
  if (!path) {
    throw new Error("Sandbox file path is required.");
  }
  if (!contents && !contentsBase64) {
    throw new Error("Sandbox file contents are required.");
  }
  return {
    path,
    contents,
    contentsBase64,
  };
}

export function normalizeMoveFileInput(payload: unknown) {
  const input = asRecord(payload);
  const fromPath = typeof input.fromPath === "string" ? input.fromPath.trim() : "";
  const toPath = typeof input.toPath === "string" ? input.toPath.trim() : "";
  if (!fromPath || !toPath) {
    throw new Error("Sandbox file source and target paths are required.");
  }
  return {
    fromPath,
    toPath,
    overwrite: typeof input.overwrite === "boolean" ? input.overwrite : undefined,
  };
}

export function normalizeGitBranchInput(payload: unknown): SandboxGitBranchInput {
  const input = asRecord(payload);
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const startPoint = typeof input.startPoint === "string" ? input.startPoint.trim() : "";
  if (!branch) {
    throw new Error("Sandbox git branch name is required.");
  }
  return {
    branch,
    create: input.create === true,
    ...(startPoint ? { startPoint } : {}),
  };
}

export function normalizeGitCommitInput(payload: unknown): SandboxGitCommitInput {
  const input = asRecord(payload);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const all = input.all === true;
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
    : [];
  if (!message) {
    throw new Error("Sandbox git commit message is required.");
  }
  if (!all && paths.length === 0) {
    throw new Error("Sandbox git commit requires all=true or at least one path.");
  }
  return {
    message,
    ...(all ? { all: true } : { paths: paths.map((path) => path.trim()) }),
  };
}

export function normalizeGitPullInput(payload: unknown): SandboxGitPullInput {
  const input = asRecord(payload);
  const remote = typeof input.remote === "string" ? input.remote.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const rebase = input.rebase === true;
  const ffOnly = typeof input.ffOnly === "boolean" ? input.ffOnly : undefined;
  if (rebase && ffOnly) {
    throw new Error("Sandbox git pull cannot use rebase and ff-only together.");
  }
  return {
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    ...(rebase ? { rebase } : {}),
    ...(typeof ffOnly === "boolean" ? { ffOnly } : {}),
  };
}

export function normalizeGitPushInput(payload: unknown): SandboxGitPushInput {
  const input = asRecord(payload);
  const remote = typeof input.remote === "string" ? input.remote.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  return {
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    ...(input.setUpstream === true ? { setUpstream: true } : {}),
    ...(input.forceWithLease === true ? { forceWithLease: true } : {}),
  };
}
