import { randomBytes } from "node:crypto";
import {
  resolveOpenPondHome, storagePaths, readOptionalFile, atomicWriteFile, withFileLock,
} from "@openpond/persistence";

export function appDataDir(): string { return resolveOpenPondHome(); }
export function providersConfigPath(storeDir: string): string { return storagePaths(storeDir).config; }
export function providerSecretsConfigPath(storeDir: string): string { return storagePaths(storeDir).credentials; }
export function providerSecretsKeyPath(storeDir: string): string { return storagePaths(storeDir).key; }
export async function ensureCapabilityToken(storeDir: string): Promise<{ token: string; tokenFile: string }> {
  const tokenFile = storagePaths(storeDir).token;
  return withFileLock(tokenFile, async () => {
    const existing = (await readOptionalFile(tokenFile))?.trim();
    const token = process.env.OPENPOND_APP_TOKEN || existing || randomBytes(32).toString("base64url");
    if (token !== existing) await atomicWriteFile(tokenFile, token);
    return { token, tokenFile };
  });
}
