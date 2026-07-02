import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ProviderCredentialDeleteRequestSchema,
  ProviderCredentialWriteRequestSchema,
  type ProviderCredentialDeleteRequest,
  type ProviderCredentialWriteRequest,
  type ProviderId,
} from "@openpond/contracts";

export type ProviderSecretRecord = {
  source: "local_secret" | "env";
  value: string | null;
  envVar: string | null;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastError: string | null;
};

export type ProviderSecrets = {
  version: 1;
  providers: Record<string, ProviderSecretRecord>;
};

type ProviderSecretFileRecord = {
  source: "local_secret" | "env";
  envVar?: string | null;
  ciphertext?: string | null;
  iv?: string | null;
  tag?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastValidatedAt?: string | null;
  lastError?: string | null;
};

type ProviderSecretsFile = {
  version: 1;
  providers: Record<string, ProviderSecretFileRecord>;
};

const providerSecretQueues = new Map<string, Promise<void>>();

export type ProviderSecretStorePaths = {
  secretsFilePath: string;
  keyFilePath: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseSecretsFile(value: unknown): ProviderSecretsFile {
  const input = asRecord(value);
  const rawProviders = asRecord(input.providers);
  const providers: Record<string, ProviderSecretFileRecord> = {};
  for (const [providerId, rawValue] of Object.entries(rawProviders)) {
    const raw = asRecord(rawValue);
    const source = raw.source === "env" || raw.source === "local_secret" ? raw.source : null;
    if (!source) continue;
    providers[providerId] = {
      source,
      envVar: stringValue(raw.envVar),
      ciphertext: stringValue(raw.ciphertext),
      iv: stringValue(raw.iv),
      tag: stringValue(raw.tag),
      createdAt: stringValue(raw.createdAt),
      updatedAt: stringValue(raw.updatedAt),
      lastValidatedAt: stringValue(raw.lastValidatedAt),
      lastError: stringValue(raw.lastError),
    };
  }
  return { version: 1, providers };
}

async function readSecretKey(keyFilePath: string): Promise<Buffer | null> {
  try {
    const raw = await fs.readFile(keyFilePath, "utf8");
    const key = Buffer.from(raw.trim(), "base64");
    return key.byteLength === 32 ? key : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSecretKey(keyFilePath: string): Promise<Buffer> {
  const existing = await readSecretKey(keyFilePath);
  if (existing) return existing;
  const key = randomBytes(32);
  await fs.mkdir(path.dirname(keyFilePath), { recursive: true });
  const tempPath = `${keyFilePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  await fs.rename(tempPath, keyFilePath);
  await fs.chmod(keyFilePath, 0o600).catch(() => undefined);
  return key;
}

function encryptValue(value: string, key: Buffer): Pick<ProviderSecretFileRecord, "ciphertext" | "iv" | "tag"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptValue(record: ProviderSecretFileRecord, key: Buffer | null): string | null {
  if (!key || !record.ciphertext || !record.iv || !record.tag) return null;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function readRawSecretsFile(secretsFilePath: string): Promise<ProviderSecretsFile> {
  try {
    const raw = await fs.readFile(secretsFilePath, "utf8");
    return parseSecretsFile(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: {} };
    throw error;
  }
}

async function writeRawSecretsFile(
  secretsFilePath: string,
  value: ProviderSecretsFile,
): Promise<void> {
  await fs.mkdir(path.dirname(secretsFilePath), { recursive: true });
  const tempPath = `${secretsFilePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, secretsFilePath);
  await fs.chmod(secretsFilePath, 0o600).catch(() => undefined);
}

export async function readProviderSecrets(paths: ProviderSecretStorePaths): Promise<ProviderSecrets> {
  const raw = await readRawSecretsFile(paths.secretsFilePath);
  const needsKey = Object.values(raw.providers).some((record) => record.source === "local_secret");
  const key = needsKey ? await readSecretKey(paths.keyFilePath) : null;
  const providers: Record<string, ProviderSecretRecord> = {};
  for (const [providerId, record] of Object.entries(raw.providers)) {
    const createdAt = record.createdAt ?? record.updatedAt ?? null;
    const updatedAt = record.updatedAt ?? record.createdAt ?? null;
    if (!createdAt || !updatedAt) continue;
    if (record.source === "env") {
      providers[providerId] = {
        source: "env",
        value: null,
        envVar: record.envVar ?? null,
        createdAt,
        updatedAt,
        lastValidatedAt: record.lastValidatedAt ?? null,
        lastError: record.lastError ?? null,
      };
      continue;
    }
    let value: string | null = null;
    let lastError = record.lastError ?? null;
    try {
      value = decryptValue(record, key);
      if (!value) lastError = lastError ?? "Provider credential could not be decrypted.";
    } catch (error) {
      value = null;
      lastError = error instanceof Error ? error.message : String(error);
    }
    providers[providerId] = {
      source: "local_secret",
      value,
      envVar: null,
      createdAt,
      updatedAt,
      lastValidatedAt: record.lastValidatedAt ?? null,
      lastError,
    };
  }
  return { version: 1, providers };
}

export function parseProviderCredentialWriteRequest(
  input: unknown,
): ProviderCredentialWriteRequest {
  return ProviderCredentialWriteRequestSchema.parse(input);
}

export function parseProviderCredentialDeleteRequest(
  input: unknown,
): ProviderCredentialDeleteRequest {
  return ProviderCredentialDeleteRequestSchema.parse(input);
}

export async function writeProviderCredential(input: {
  paths: ProviderSecretStorePaths;
  providerId: ProviderId;
  request: ProviderCredentialWriteRequest;
  timestamp: string;
}): Promise<ProviderSecrets> {
  return withProviderSecretQueue(input.paths, async () => {
    const current = await readRawSecretsFile(input.paths.secretsFilePath);
    const existing = current.providers[input.providerId];
    if (input.request.source === "env") {
      current.providers[input.providerId] = {
        source: "env",
        envVar: input.request.envVar ?? null,
        createdAt: existing?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
        lastValidatedAt: null,
        lastError: null,
      };
    } else {
      if (!input.request.value) throw new Error("Provider credential value is required.");
      current.providers[input.providerId] = {
        source: "local_secret",
        ...encryptValue(input.request.value, await ensureSecretKey(input.paths.keyFilePath)),
        createdAt: existing?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
        lastValidatedAt: null,
        lastError: null,
      };
    }
    await writeRawSecretsFile(input.paths.secretsFilePath, current);
    return readProviderSecrets(input.paths);
  });
}

export async function deleteProviderCredential(input: {
  paths: ProviderSecretStorePaths;
  providerId: ProviderId;
  request: ProviderCredentialDeleteRequest;
}): Promise<ProviderSecrets> {
  return withProviderSecretQueue(input.paths, async () => {
    const current = await readRawSecretsFile(input.paths.secretsFilePath);
    const existing = current.providers[input.providerId];
    if (!existing) return readProviderSecrets(input.paths);
    if (!input.request.source || input.request.source === existing.source) {
      delete current.providers[input.providerId];
      await writeRawSecretsFile(input.paths.secretsFilePath, current);
    }
    return readProviderSecrets(input.paths);
  });
}

export async function updateProviderCredentialValidation(input: {
  paths: ProviderSecretStorePaths;
  providerId: ProviderId;
  timestamp: string;
  lastError: string | null;
}): Promise<ProviderSecrets> {
  return withProviderSecretQueue(input.paths, async () => {
    const current = await readRawSecretsFile(input.paths.secretsFilePath);
    const existing = current.providers[input.providerId];
    if (!existing) return readProviderSecrets(input.paths);
    current.providers[input.providerId] = {
      ...existing,
      lastValidatedAt: input.timestamp,
      lastError: input.lastError,
    };
    await writeRawSecretsFile(input.paths.secretsFilePath, current);
    return readProviderSecrets(input.paths);
  });
}

function withProviderSecretQueue<T>(paths: ProviderSecretStorePaths, task: () => Promise<T>): Promise<T> {
  const filePath = paths.secretsFilePath;
  const previous = providerSecretQueues.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const queued = run
    .catch(() => undefined)
    .then(() => {
      if (providerSecretQueues.get(filePath) === queued) providerSecretQueues.delete(filePath);
    });
  providerSecretQueues.set(filePath, queued);
  return run;
}
