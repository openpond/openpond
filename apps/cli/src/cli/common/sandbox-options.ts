import { loadConfig } from "../../config";
import type { OpenPondSandboxClient } from "../../sandbox/client";
import { createOpenPondSandboxClient } from "../../sandbox/client";
import type { SandboxTemplateManifest } from "../../sandbox-template/manifest";
import { DEFAULT_OPENPOND_API_BASE_URL } from "../../urls";
import {
  SANDBOX_RUNTIME_PROFILE_IDS,
  type SandboxEnvVarInput,
  type SandboxRuntimeProfileId,
  type SandboxRuntimePromotionPolicy,
  type SandboxSecretMetadata,
  type SandboxWorkflowMode,
} from "../../sandbox/types/index";
import { ensureApiKey } from "./auth";
import { parseBooleanOption } from "./options";
import { readAllStdin, readMaskedLine } from "./prompts";
import {
  mapUiBaseToApiBase,
  resolveBaseUrl,
  resolveSandboxApiUrlOption,
} from "./urls";

export const SANDBOX_WORKFLOW_MODES: SandboxWorkflowMode[] = [
  "readonly",
  "attempt",
  "feature",
  "rollout",
  "replay",
  "template_build",
  "scheduled_run",
  "patch_only",
  "hotfix",
  "multi_feature_batch",
];
export const SANDBOX_RUNTIME_PROMOTION_POLICIES: SandboxRuntimePromotionPolicy[] =
  ["none", "manual", "auto_after_checks"];
export const SANDBOX_RUNTIME_PROFILES: SandboxRuntimeProfileId[] = [
  ...SANDBOX_RUNTIME_PROFILE_IDS,
];

export function resolveSandboxBaseUrl(
  config: import("../../config").LocalConfig,
  options: Record<string, string | boolean>
): string {
  const envName =
    typeof options.env === "string"
      ? options.env.trim().toLowerCase()
      : typeof options.environment === "string"
      ? options.environment.trim().toLowerCase()
      : "";
  if (envName === "staging") {
    return "https://api-new.staging-api.openpond.ai";
  }
  if (envName && envName !== "production") {
    throw new Error("sandbox env must be staging or production");
  }
  const base =
    process.env.OPENPOND_SANDBOX_BASE_URL ||
    process.env.OPENPOND_API_URL ||
    config.apiBaseUrl ||
    mapUiBaseToApiBase(process.env.OPENPOND_BASE_URL || config.baseUrl) ||
    DEFAULT_OPENPOND_API_BASE_URL;
  return base.replace(/\/$/, "");
}

export async function resolveSandboxClient(
  options: Record<string, string | boolean>
): Promise<OpenPondSandboxClient> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const sandboxApiUrl =
    resolveSandboxApiUrlOption(options) ||
    process.env.OPENPOND_SANDBOX_API_URL?.trim() ||
    null;
  return createOpenPondSandboxClient(
    sandboxApiUrl
      ? { apiKey, sandboxApiUrl }
      : { apiKey, baseUrl: resolveSandboxBaseUrl(config, options) }
  );
}

export function parseSandboxWorkflowModeOption(
  value: string | boolean | undefined
): SandboxWorkflowMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("workflow-mode must be a non-empty value");
  }
  const mode = value.trim() as SandboxWorkflowMode;
  if (!SANDBOX_WORKFLOW_MODES.includes(mode)) {
    throw new Error(
      `workflow-mode must be one of ${SANDBOX_WORKFLOW_MODES.join(", ")}`
    );
  }
  return mode;
}

export function parseSandboxRuntimePromotionPolicyOption(
  value: string | boolean | undefined
): SandboxRuntimePromotionPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("runtime-promotion-policy must be a non-empty value");
  }
  const policy = value.trim() as SandboxRuntimePromotionPolicy;
  if (!SANDBOX_RUNTIME_PROMOTION_POLICIES.includes(policy)) {
    throw new Error(
      `runtime-promotion-policy must be one of ${SANDBOX_RUNTIME_PROMOTION_POLICIES.join(
        ", "
      )}`
    );
  }
  return policy;
}

export function parseSandboxRuntimeProfileIdOption(
  value: string | boolean | undefined
): SandboxRuntimeProfileId | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const runtimeProfileId = value.trim() as SandboxRuntimeProfileId;
  if (!SANDBOX_RUNTIME_PROFILES.includes(runtimeProfileId)) {
    throw new Error(
      `runtime-profile-id must be one of ${SANDBOX_RUNTIME_PROFILES.join(
        ", "
      )}`
    );
  }
  return runtimeProfileId;
}

export const parseSandboxRuntimeEnvironmentIdOption =
  parseSandboxRuntimeProfileIdOption;

export function parseSandboxEnvOptions(
  options: Record<string, string | boolean>
): SandboxEnvVarInput[] {
  const refs = parseSandboxEnvAssignments(options.envRef, "env-ref").map(
    ({ name, value }) => ({ name, secretRef: value })
  );
  const literals = parseSandboxEnvAssignments(
    options.envLiteral,
    "env-literal"
  ).map(({ name, value }) => {
    if (
      isSecretLikeEnvName(name) &&
      !parseBooleanOption(options.allowPlainSecretEnv)
    ) {
      throw new Error(
        `refusing plaintext value for secret-like env ${name}; create a sandbox secret and pass --env-ref ${name}=openpond://secret/...`
      );
    }
    return { name, value };
  });
  const env = [...refs, ...literals];
  const names = new Set<string>();
  for (const item of env) {
    if (names.has(item.name)) {
      throw new Error(`duplicate sandbox env var: ${item.name}`);
    }
    names.add(item.name);
  }
  return env;
}

export function parseSandboxTemplateEnvOptions(
  manifest: SandboxTemplateManifest,
  options: Record<string, string | boolean>
): SandboxEnvVarInput[] {
  const env = parseSandboxEnvOptions(options);
  const provided = new Set(env.map((item) => item.name));
  const providedByName = new Map(env.map((item) => [item.name, item]));
  for (const requirement of manifest.inputs.env) {
    const value = providedByName.get(requirement.name);
    if (value?.value !== undefined && requirement.secret !== false) {
      throw new Error(
        `sandbox template env ${requirement.name} requires a secret ref. Pass --env-ref ${requirement.name}=openpond://secret/...`
      );
    }
  }
  const missing = manifest.inputs.env
    .filter((item) => item.required && !provided.has(item.name))
    .map((item) => item.name);
  if (missing.length > 0) {
    throw new Error(
      `missing required sandbox template env refs: ${missing.join(
        ", "
      )}. Pass --env-ref NAME=openpond://secret/...`
    );
  }
  return env;
}

export function parseSandboxEnvAssignments(
  value: string | boolean | undefined,
  label: string
): Array<{ name: string; value: string }> {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      if (separator <= 0) {
        throw new Error(`${label} entries must use NAME=value`);
      }
      const name = item.slice(0, separator).trim();
      const entryValue = item.slice(separator + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`${label} has invalid env name: ${name}`);
      }
      if (!entryValue) {
        throw new Error(`${label} value is required for ${name}`);
      }
      return { name, value: entryValue };
    });
}

export function isSecretLikeEnvName(name: string): boolean {
  return /(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DATABASE_URL|DSN)/i.test(
    name
  );
}

export async function readSandboxSecretValue(
  options: Record<string, string | boolean>,
  label: string
): Promise<string> {
  if (
    typeof options.value === "string" ||
    typeof options.secretValue === "string"
  ) {
    throw new Error(
      "sandbox secret values must be provided with --stdin or the masked prompt"
    );
  }
  const useStdin = parseBooleanOption(options.stdin);
  if (useStdin) {
    const value = await readAllStdin();
    if (!value) throw new Error(`${label} read no secret value from stdin`);
    return value;
  }
  if (!process.stdin.isTTY) {
    throw new Error(`${label} requires --stdin when not running in a TTY`);
  }
  const value = await readMaskedLine(`${label}: `);
  if (!value) throw new Error(`${label} cannot be empty`);
  return value;
}

export function summarizeSandboxSecret(
  secret: SandboxSecretMetadata
): Record<string, unknown> {
  return {
    id: secret.id,
    teamId: secret.teamId,
    name: secret.name,
    scope: secret.scope,
    status: secret.status,
    secretRef: secret.secretRef,
    currentVersion: secret.currentVersion,
    updatedAt: secret.updatedAt,
    lastUsedAt: secret.lastUsedAt,
    attachedDestinations: secret.attachments?.length ?? 0,
  };
}
