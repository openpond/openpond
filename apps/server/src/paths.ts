import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function appDataDir(): string {
  return process.env.OPENPOND_APP_HOME || path.join(os.homedir(), ".openpond", "openpond-app");
}

export function providersConfigPath(storeDir: string): string {
  return path.join(storeDir, "providers.json");
}

export function providerSecretsConfigPath(storeDir: string): string {
  return path.join(storeDir, "provider-secrets.json");
}

export function providerSecretsKeyPath(storeDir: string): string {
  return path.join(storeDir, "provider-secrets.key");
}

export function soulPath(storeDir: string): string {
  return path.join(storeDir, "SOUL.md");
}

export function soulsDir(storeDir: string): string {
  return path.join(storeDir, "souls");
}

export function personalizationStatePath(storeDir: string): string {
  return path.join(storeDir, "personalization.json");
}

export async function ensureCapabilityToken(storeDir: string): Promise<{ token: string; tokenFile: string }> {
  await fs.mkdir(storeDir, { recursive: true });
  const tokenFile = path.join(storeDir, "token");
  if (process.env.OPENPOND_APP_TOKEN) {
    await fs.writeFile(tokenFile, process.env.OPENPOND_APP_TOKEN, { mode: 0o600 });
    return { token: process.env.OPENPOND_APP_TOKEN, tokenFile };
  }
  try {
    const token = (await fs.readFile(tokenFile, "utf8")).trim();
    if (token) return { token, tokenFile };
  } catch {
    // Generated below.
  }
  const token = randomBytes(32).toString("base64url");
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  return { token, tokenFile };
}
