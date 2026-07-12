import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

type SecretFile = { version: 1; destinations: Record<string, { ciphertext: string; iv: string; tag: string; createdAt: string; updatedAt: string }> };
const queues = new Map<string, Promise<void>>();

export type TrainingDestinationSecretRef = { destinationId: string; configured: boolean; createdAt: string | null; updatedAt: string | null };

export async function writeTrainingDestinationSecret(input: { directory: string; destinationId: string; value: string; timestamp: string }): Promise<TrainingDestinationSecretRef> {
  if (!input.value.trim()) throw new Error("Training destination credential is required.");
  return queued(input.directory, async () => {
    const file = await readSecrets(input.directory);
    const existing = file.destinations[input.destinationId];
    const key = await ensureKey(input.directory);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    file.destinations[input.destinationId] = { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), createdAt: existing?.createdAt ?? input.timestamp, updatedAt: input.timestamp };
    await writeSecrets(input.directory, file);
    return { destinationId: input.destinationId, configured: true, createdAt: file.destinations[input.destinationId]!.createdAt, updatedAt: input.timestamp };
  });
}

export async function readTrainingDestinationSecret(input: { directory: string; destinationId: string }): Promise<string | null> {
  const file = await readSecrets(input.directory);
  const record = file.destinations[input.destinationId];
  if (!record) return null;
  const key = await readFile(keyPath(input.directory));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export async function listTrainingDestinationSecretRefs(directory: string): Promise<TrainingDestinationSecretRef[]> {
  const file = await readSecrets(directory);
  return Object.entries(file.destinations).map(([destinationId, record]) => ({ destinationId, configured: true, createdAt: record.createdAt, updatedAt: record.updatedAt }));
}

async function ensureKey(directory: string): Promise<Buffer> {
  try { const key = await readFile(keyPath(directory)); if (key.byteLength === 32) return key; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const key = randomBytes(32);
  await mkdir(directory, { recursive: true });
  await writeFile(keyPath(directory), key, { mode: 0o600 });
  return key;
}
async function readSecrets(directory: string): Promise<SecretFile> { try { const value = JSON.parse(await readFile(filePath(directory), "utf8")) as SecretFile; return value.version === 1 && value.destinations ? value : { version: 1, destinations: {} }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, destinations: {} }; throw error; } }
async function writeSecrets(directory: string, value: SecretFile): Promise<void> { await mkdir(directory, { recursive: true }); const target = filePath(directory); const temporary = `${target}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, target); await chmod(target, 0o600).catch(() => undefined); }
function keyPath(directory: string): string { return path.join(directory, "training-destinations.key"); }
function filePath(directory: string): string { return path.join(directory, "training-destinations.json"); }
async function queued<T>(directory: string, action: () => Promise<T>): Promise<T> { const previous = queues.get(directory) ?? Promise.resolve(); let result!: T; const next = previous.then(async () => { result = await action(); }); queues.set(directory, next.catch(() => undefined)); await next; return result; }
