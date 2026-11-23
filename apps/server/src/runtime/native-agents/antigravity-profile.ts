import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProviderConfig } from "@openpond/contracts";

export const ANTIGRAVITY_INTEGRATION = "google-antigravity-cli";
export const isAntigravityConfig = (config?: Partial<ProviderConfig>) =>
  config?.acp?.registryId === ANTIGRAVITY_INTEGRATION;

// A subscription connection must never inherit another provider's API billing or keyring context.
const removedKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ADC_AUTH",
  "AGY_LLM_GATEWAY_URL",
  "AGY_LLM_GATEWAY_API_KEY",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "BROWSER",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
  "SSH_CONNECTION",
]);

export async function prepareAntigravityProfile(profile: string): Promise<void> {
  if (!isAbsolute(profile)) throw new Error("Antigravity requires an absolute profile directory.");
  await mkdir(join(profile, "antigravity-acp"), { recursive: true, mode: 0o700 });
  await mkdir(join(profile, "tmp"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(profile, "antigravity-acp", "settings.json"),
    `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`,
    { mode: 0o600 },
  );
}

export function antigravityLaunch(provider: string, config: Partial<ProviderConfig>) {
  const profile = config.sourceHome;
  const command = config.binaryPath || config.acp?.command;
  if (!profile || !isAbsolute(profile) || !command || !isAbsolute(command))
    throw new Error("Install Antigravity in Providers before connecting.");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!removedKeys.has(key.toUpperCase())) env[key] = value;
  Object.assign(env, {
    GEMINI_HOME: profile,
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    // The native CLI's SSH flow stores the Google login in this profile instead of a shared OS keyring.
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
    PYTHONUNBUFFERED: "1",
    ...(process.platform === "win32"
      ? { TEMP: join(profile, "tmp"), TMP: join(profile, "tmp") }
      : { TMPDIR: join(profile, "tmp") }),
  });
  // Runtime upgrades preserve identity; changing the account creates a different profile.
  const instanceId = createHash("sha256")
    .update(JSON.stringify([provider, ANTIGRAVITY_INTEGRATION, profile, config.binaryPath ?? null]))
    .digest("hex");
  return {
    command,
    args: ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp"],
    env,
    sourceHome: profile,
    instanceId,
    requestTimeoutMs: 120_000,
    resumeMethod: "session/resume" as const,
    authRequiredPrefix: "Open the following link to authenticate the ACP server: ",
  };
}
