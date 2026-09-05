import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { storagePaths } from "./home.js";
import { atomicWriteFile, readJsonFile, readOptionalFile, withFileLock } from "./private-file.js";
import { PersistenceError } from "./errors.js";

const RecordSchema = z.strictObject({ owner: z.string(), revision: z.number().int().positive(), algorithm: z.literal("aes-256-gcm"), keyId: z.string(), iv: z.string(), ciphertext: z.string(), tag: z.string() });
const VaultSchema = z.strictObject({ schemaVersion: z.literal("openpond.credentials.v1"), records: z.record(z.string(), RecordSchema) });
type Vault = z.infer<typeof VaultSchema>;
export type CredentialValue<T> = { revision: number; value: T };

async function readVault(home: string): Promise<Vault> {
  const filePath = storagePaths(home).credentials;
  try { return VaultSchema.parse(await readJsonFile(filePath, () => ({ schemaVersion: "openpond.credentials.v1", records: {} }))); }
  catch (cause) { if (cause instanceof PersistenceError) throw cause; throw credentialError(home, "The credential store has an invalid format.", cause); }
}

async function readKey(home: string, create: boolean): Promise<Buffer> {
  const paths = storagePaths(home);
  const text = await readOptionalFile(paths.key);
  if (text === null && create && await readOptionalFile(paths.credentials) === null) {
    const key = randomBytes(32);
    await atomicWriteFile(paths.key, `${key.toString("base64")}\n`);
    return key;
  }
  const key = text ? Buffer.from(text.trim(), "base64") : null;
  if (!key || key.length !== 32) throw credentialError(home, "The credential encryption key is missing or invalid.");
  return key;
}

function credentialError(home: string, message: string, cause?: unknown): PersistenceError {
  return new PersistenceError({ code: "CREDENTIAL_RECOVERY_REQUIRED", path: storagePaths(home).credentials, message, action: "Restore the matching credential store and key from a verified backup. Existing files have been preserved." }, { cause });
}

function decrypt<T>(home: string, id: string, record: z.infer<typeof RecordSchema>, key: Buffer): CredentialValue<T> {
  try {
    if (record.owner !== id || record.keyId !== createHash("sha256").update(key).digest("hex")) throw new Error("Credential ownership mismatch");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(`${id}:${record.revision}`));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8")) as T;
    return { revision: record.revision, value };
  } catch (cause) { throw credentialError(home, "A credential could not be verified or decrypted.", cause); }
}

export async function readCredential<T>(home: string, id: string): Promise<CredentialValue<T> | null> {
  const vault = await readVault(home), record = vault.records[id];
  return record ? decrypt(home, id, record, await readKey(home, false)) : null;
}

export async function readCredentials<T>(home: string, prefix: string): Promise<Record<string, CredentialValue<T>>> {
  const vault = await readVault(home), entries = Object.entries(vault.records).filter(([id]) => id.startsWith(prefix));
  if (!entries.length) return {};
  const key = await readKey(home, false);
  return Object.fromEntries(entries.map(([id, record]) => [id, decrypt<T>(home, id, record, key)]));
}

export async function writeCredential<T>(home: string, id: string, value: T, expectedRevision?: number | null): Promise<number> {
  return withFileLock(storagePaths(home).credentials, async () => {
    const vault = await readVault(home), existing = vault.records[id];
    if (expectedRevision !== undefined && expectedRevision !== (existing?.revision ?? null)) throw new PersistenceError({ code: "CREDENTIAL_CONFLICT", path: id, message: "This credential changed or was revoked.", action: "Reload the connection before retrying." });
    const key = await readKey(home, true), revision = (existing?.revision ?? 0) + 1, iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${id}:${revision}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    vault.records[id] = { owner: id, revision, algorithm: "aes-256-gcm", keyId: createHash("sha256").update(key).digest("hex"), iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    await atomicWriteFile(storagePaths(home).credentials, `${JSON.stringify(vault, null, 2)}\n`);
    return revision;
  });
}

export async function deleteCredential(home: string, id: string): Promise<void> {
  await withFileLock(storagePaths(home).credentials, async () => {
    const vault = await readVault(home);
    if (!(id in vault.records)) return;
    delete vault.records[id];
    await atomicWriteFile(storagePaths(home).credentials, `${JSON.stringify(vault, null, 2)}\n`);
  });
}

export function newCredentialId(owner: string): string { return `${owner}:${randomUUID()}`; }

/** Opaque per-record versions expose neither plaintext nor encrypted credential bytes. */
export async function credentialVersions(home: string, ids: string[]): Promise<Record<string, string | null>> {
  const vault = await readVault(home);
  const key = ids.some((id) => vault.records[id]) ? await readKey(home, false) : null;
  return Object.fromEntries([...new Set(ids)].sort().map((id) => {
    const record = vault.records[id];
    if (!record || !key) return [id, null];
    const value = decrypt<Record<string, unknown>>(home, id, record, key).value;
    // Provider login creates a fresh credential ID. CAS refresh retains that ID
    // and account binding; rotating its short-lived tokens is not revocation.
    const identity = id.startsWith("provider:") && value?.source === "chatgpt_subscription"
      ? { id, keyId: record.keyId, source: value.source, endpoint: value.endpoint, createdAt: value.createdAt,
          accountId: (value.oauth as { accountId?: unknown } | null)?.accountId }
      : record;
    return [id, createHash("sha256").update(JSON.stringify(identity)).digest("hex")];
  }));
}
