import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { saveGlobalConfig, type LocalConfig } from "../../config";
import { DEFAULT_OPENPOND_WEB_BASE_URL } from "../../urls";

export const UI_API_KEY_URL = `${DEFAULT_OPENPOND_WEB_BASE_URL}/settings/api-keys`;

export function resolveApiKey(config: LocalConfig): string | null {
  const envKey = process.env.OPENPOND_API_KEY?.trim();
  if (envKey) return envKey;
  const stored = config.apiKey?.trim();
  if (stored) return stored;
  const legacy = config.token?.trim();
  if (legacy && legacy.startsWith("opk_")) return legacy;
  return null;
}

export async function promptForApiKey(): Promise<string> {
  console.log("Open the OpenPond UI to create an API key:");
  console.log(UI_API_KEY_URL);
  const rl = createInterface({ input, output });
  try {
    const value = (await rl.question("Paste your OpenPond API key: ")).trim();
    if (!value) {
      throw new Error("API key is required");
    }
    if (!value.startsWith("opk_")) {
      console.log("warning: API keys usually start with opk_.");
    }
    return value;
  } finally {
    rl.close();
  }
}

export async function ensureApiKey(
  config: LocalConfig,
  baseUrl: string
): Promise<string> {
  const existing = resolveApiKey(config);
  if (existing) return existing;
  const apiKey = await promptForApiKey();
  await saveGlobalConfig({
    apiKey,
    baseUrl,
    activeProfile: config.activeProfile,
  });
  console.log("saved api key to ~/.openpond/config.json");
  return apiKey;
}
