import path from "node:path";
import {
  ProviderCredentialDeleteRequestSchema, ProviderCredentialWriteRequestSchema,
  type ProviderCredentialDeleteRequest, type ProviderCredentialWriteRequest, type ProviderId,
} from "@openpond/contracts";
import {
  readConfig, updateConfig, readCredential, writeCredential, deleteCredential, newCredentialId,
  getLocalRecord, putLocalRecord, deleteLocalRecord, withFileLock, storagePaths, PersistenceError,
} from "@openpond/persistence";

export type ProviderSecretRecord = {
  credentialId?: string;
  revision?: number;
  endpoint?: string | null;
  source: "local_secret" | "env" | "chatgpt_subscription";
  value: string | null;
  envVar: string | null;
  oauth: ProviderChatGptSubscriptionCredential | null;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastError: string | null;
};

export type ProviderChatGptSubscriptionCredential = {
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number;
  accountId: string | null;
};

export type ProviderSecrets = {
  version: 1;
  providers: Record<string, ProviderSecretRecord>;
};

export type ProviderSecretStorePaths = { secretsFilePath: string; keyFilePath: string };
function homeFor(paths: ProviderSecretStorePaths): string { return path.dirname(path.dirname(paths.secretsFilePath)); }
function locked<T>(paths: ProviderSecretStorePaths, task: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(storagePaths(homeFor(paths)).runtime, "providers"), task);
}

async function readUnlocked(paths: ProviderSecretStorePaths): Promise<ProviderSecrets> {
  const home = homeFor(paths), { document } = await readConfig(home);
  const providers: ProviderSecrets["providers"] = {};
  for (const [id, provider] of Object.entries(document.providers ?? {})) {
    const ref = provider.credential;
    if (!ref) continue;
    const metadata = getLocalRecord<Partial<ProviderSecretRecord>>(home, "provider_connection_state", id)?.value;
    if (ref.source === "env") {
      providers[id] = { source: "env", value: null, envVar: ref.name, oauth: null,
        createdAt: metadata?.createdAt ?? "1970-01-01T00:00:00.000Z", updatedAt: metadata?.updatedAt ?? "1970-01-01T00:00:00.000Z",
        lastValidatedAt: metadata?.lastValidatedAt ?? null, lastError: metadata?.lastError ?? null, credentialId: `env:${ref.name}` };
      continue;
    }
    const saved = await readCredential<ProviderSecretRecord>(home, ref.id);
    if (!saved) throw new PersistenceError({ code: "CREDENTIAL_RECOVERY_REQUIRED", path: ref.id, message: `The credential for ${id} is missing.`, action: "Reconnect this provider in Settings or restore its credential backup." });
    const record = { ...saved.value, ...(metadata ? { lastValidatedAt: metadata.lastValidatedAt ?? null, lastError: metadata.lastError ?? null } : {}), credentialId: ref.id, revision: saved.revision };
    if ((record.endpoint ?? null) !== (provider.base_url ?? null)) {
      providers[id] = { ...record, value: null, oauth: null, lastError: "The provider endpoint changed. Reconnect the provider for this endpoint." };
    } else providers[id] = record;
  }
  return { version: 1, providers };
}
export async function readProviderSecrets(paths: ProviderSecretStorePaths): Promise<ProviderSecrets> {
  return locked(paths, () => readUnlocked(paths));
}
export function parseProviderCredentialWriteRequest(input: unknown): ProviderCredentialWriteRequest {
  return ProviderCredentialWriteRequestSchema.parse(input);
}
export function parseProviderCredentialDeleteRequest(input: unknown): ProviderCredentialDeleteRequest {
  return ProviderCredentialDeleteRequestSchema.parse(input);
}
type ExpectedCredential = { credentialId?: string; revision?: number };
function checkExpected(existing: ProviderSecretRecord | undefined, expected: ExpectedCredential): void {
  if (!existing || existing.credentialId !== expected.credentialId || existing.revision !== expected.revision) {
    throw new PersistenceError({ code: "CREDENTIAL_CONFLICT", path: existing?.credentialId ?? "providers", message: "The provider connection changed or was revoked.", action: "Reconnect the provider before retrying." });
  }
}
async function save(paths: ProviderSecretStorePaths, providerId: string, record: ProviderSecretRecord, expected?: ExpectedCredential): Promise<ProviderSecrets> {
  return locked(paths, async () => {
    const home = homeFor(paths), current = await readUnlocked(paths), existing = current.providers[providerId];
    if (expected) checkExpected(existing, expected);
    const snapshot = await readConfig(home), previous = snapshot.document.providers?.[providerId]?.credential;
    if (expected && (previous?.source !== "secret" || previous.id !== existing?.credentialId || (snapshot.document.providers?.[providerId]?.base_url ?? null) !== (existing?.endpoint ?? null))) throw new PersistenceError({ code: "CREDENTIAL_CONFLICT", path: providerId, message: "The provider connection changed during refresh.", action: "Reconnect the provider before retrying." });
    if (expected && existing?.source === "chatgpt_subscription" && record.source === "chatgpt_subscription" && previous?.source === "secret") {
      if (existing.oauth?.accountId !== record.oauth?.accountId) throw new PersistenceError({ code: "CREDENTIAL_CONFLICT", path: previous.id, message: "The refreshed credential belongs to another account.", action: "Reconnect the provider before retrying." });
      await writeCredential(home, previous.id, { ...record, endpoint: existing.endpoint ?? null, createdAt: existing.createdAt }, existing.revision);
      deleteLocalRecord(home, "provider_connection_state", providerId);
      return readUnlocked(paths);
    }
    const credentialId = newCredentialId(`provider:${providerId}`);
    const value = { ...record, endpoint: snapshot.document.providers?.[providerId]?.base_url ?? null, createdAt: existing?.createdAt ?? record.createdAt };
    if (value.source !== "env") await writeCredential(home, credentialId, value, null);
    await updateConfig(home, (document) => ({ ...document, providers: { ...document.providers,
      [providerId]: { ...document.providers?.[providerId], credential: value.source === "env" ? { source: "env", name: value.envVar! } : { source: "secret", id: credentialId } },
    } }), snapshot.rawRevision);
    if (value.source === "env") putLocalRecord(home, "provider_connection_state", providerId, { createdAt: value.createdAt, updatedAt: value.updatedAt, lastValidatedAt: value.lastValidatedAt, lastError: value.lastError });
    else deleteLocalRecord(home, "provider_connection_state", providerId);
    if (previous?.source === "secret") await deleteCredential(home, previous.id);
    return readUnlocked(paths);
  });
}
export async function writeProviderCredential(input: { paths: ProviderSecretStorePaths; providerId: string; request: ProviderCredentialWriteRequest; timestamp: string }): Promise<ProviderSecrets> {
  if (input.request.source !== "env" && !input.request.value) throw new Error("Provider credential value is required.");
  return save(input.paths, input.providerId, { source: input.request.source, value: input.request.source === "env" ? null : input.request.value!, envVar: input.request.source === "env" ? input.request.envVar! : null, oauth: null,
    createdAt: input.timestamp, updatedAt: input.timestamp, lastValidatedAt: null, lastError: null });
}
export async function writeProviderChatGptSubscriptionCredential(input: { paths: ProviderSecretStorePaths; providerId: ProviderId; credential: ProviderChatGptSubscriptionCredential; timestamp: string; lastError?: string | null; expected?: ExpectedCredential }): Promise<ProviderSecrets> {
  return save(input.paths, input.providerId, { source: "chatgpt_subscription", value: null, envVar: null, oauth: input.credential,
    createdAt: input.timestamp, updatedAt: input.timestamp, lastValidatedAt: input.timestamp, lastError: input.lastError ?? null }, input.expected);
}
export async function deleteProviderCredential(input: { paths: ProviderSecretStorePaths; providerId: string; request: ProviderCredentialDeleteRequest }): Promise<ProviderSecrets> {
  return locked(input.paths, async () => {
    const home = homeFor(input.paths), current = await readUnlocked(input.paths), existing = current.providers[input.providerId];
    if (!existing || (input.request.source && input.request.source !== existing.source)) return current;
    const snapshot = await readConfig(home), ref = snapshot.document.providers?.[input.providerId]?.credential;
    await updateConfig(home, (document) => {
      const provider = document.providers?.[input.providerId];
      if (provider) delete provider.credential;
      return document;
    }, snapshot.rawRevision);
    if (ref?.source === "secret") await deleteCredential(home, ref.id);
    deleteLocalRecord(home, "provider_connection_state", input.providerId);
    return readUnlocked(input.paths);
  });
}
export async function updateProviderCredentialValidation(input: { paths: ProviderSecretStorePaths; providerId: string; timestamp: string; lastError: string | null; expected?: ExpectedCredential }): Promise<ProviderSecrets> {
  return locked(input.paths, async () => {
    const home = homeFor(input.paths), current = await readUnlocked(input.paths), existing = current.providers[input.providerId];
    if (!existing) return current;
    if (input.expected) checkExpected(existing, input.expected);
    putLocalRecord(home, "provider_connection_state", input.providerId, { createdAt: existing.createdAt, updatedAt: existing.updatedAt, lastValidatedAt: input.timestamp, lastError: input.lastError });
    return readUnlocked(input.paths);
  });
}
