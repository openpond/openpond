import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PrimeComputeProviderStatusSchema,
  SavePrimeComputeCredentialRequestSchema,
  type PrimeComputeProviderStatus,
} from "@openpond/contracts";
import { probePrimeCredential } from "@openpond/compute-provider-prime";

import {
  deleteProviderCredential,
  readProviderSecrets,
  updateProviderCredentialValidation,
  writeProviderCredential,
  type ProviderSecretRecord,
  type ProviderSecretStorePaths,
} from "../openpond/provider-secrets.js";

const SECRET_ID = "prime-compute";
const REDACTED_CREDENTIAL = "••••••••••••";

type ValidationSnapshot = {
  schemaVersion: "openpond.primeComputeValidation.v1";
  credentialUpdatedAt: string;
  checkedAt: string;
  availability: PrimeComputeProviderStatus["availability"];
  lastError: string | null;
};

export type PrimeWorkerReadiness = PrimeComputeProviderStatus["worker"];

export function createPrimeComputeProviderSetup(input: {
  storeDir: string;
  secretPaths: ProviderSecretStorePaths;
  request?: typeof fetch;
  now?: () => Date;
  workerReadiness?: () => PrimeWorkerReadiness;
}) {
  const statePath = path.join(
    input.storeDir,
    "compute",
    "prime-provider-validation.json",
  );

  async function status(): Promise<PrimeComputeProviderStatus> {
    const credential = (await readProviderSecrets(input.secretPaths))
      .providers[SECRET_ID];
    const configured = Boolean(
      credential
      && credential.source === "local_secret"
      && credential.value,
    );
    const snapshot = configured
      ? await readSnapshot(statePath, credential!.updatedAt)
      : null;
    const worker = configured
      ? input.workerReadiness?.() ?? setupRequiredWorker()
      : notConfiguredWorker();
    const validated = Boolean(
      snapshot
      && !snapshot.lastError
      && credential?.lastValidatedAt === snapshot.checkedAt,
    );
    const state =
      !configured
        ? "disconnected"
        : snapshot?.lastError || credential?.lastError
          ? "error"
          : !validated
            ? "configured"
            : worker.ready
              ? "ready"
              : "credential_valid";

    return PrimeComputeProviderStatusSchema.parse({
      schemaVersion: "openpond.primeComputeProviderStatus.v1",
      providerId: "prime",
      displayName: "Prime Intellect",
      state,
      credential: {
        configured,
        redacted: configured ? REDACTED_CREDENTIAL : null,
        storedLocally: true,
      },
      availability: validated ? snapshot?.availability ?? null : null,
      worker,
      lastValidatedAt: snapshot?.checkedAt ?? credential?.lastValidatedAt ?? null,
      lastError: snapshot?.lastError ?? credential?.lastError ?? null,
    });
  }

  async function saveCredential(raw: unknown): Promise<PrimeComputeProviderStatus> {
    const request = SavePrimeComputeCredentialRequestSchema.parse(raw);
    await writeProviderCredential({
      paths: input.secretPaths,
      providerId: SECRET_ID,
      request: { source: "local_secret", value: request.apiKey },
      timestamp: timestamp(),
    });
    await rm(statePath, { force: true });
    return status();
  }

  async function deleteCredential(): Promise<PrimeComputeProviderStatus> {
    await deleteProviderCredential({
      paths: input.secretPaths,
      providerId: SECRET_ID,
      request: { source: "local_secret" },
    });
    await rm(statePath, { force: true });
    return status();
  }

  async function validateCredential(): Promise<PrimeComputeProviderStatus> {
    const credential = await resolveCredentialRecord(
      "Connect a Prime Intellect API key before verifying it.",
    );

    const checkedAt = timestamp();
    let snapshot: ValidationSnapshot;
    try {
      const result = await probePrimeCredential({
        apiKey: credential.value,
        request: input.request,
        now: input.now,
      });
      snapshot = {
        schemaVersion: "openpond.primeComputeValidation.v1",
        credentialUpdatedAt: credential.updatedAt,
        checkedAt: result.checkedAt,
        availability: {
          availableOfferingCount: result.availableOfferingCount,
          lowestHourlyUsd: result.lowestHourlyUsd,
          registeredSshKeyCount: result.registeredSshKeyCount,
        },
        lastError: null,
      };
    } catch (error) {
      snapshot = {
        schemaVersion: "openpond.primeComputeValidation.v1",
        credentialUpdatedAt: credential.updatedAt,
        checkedAt,
        availability: null,
        lastError: safeError(error, credential.value),
      };
    }
    await updateProviderCredentialValidation({
      paths: input.secretPaths,
      providerId: SECRET_ID,
      timestamp: snapshot.checkedAt,
      lastError: snapshot.lastError,
    });
    await atomicJson(statePath, snapshot);
    return status();
  }

  function timestamp(): string {
    return (input.now?.() ?? new Date()).toISOString();
  }

  async function resolveCredential(): Promise<string> {
    return (
      await resolveCredentialRecord(
        "Connect a Prime Intellect API key before launching Prime compute.",
      )
    ).value!;
  }

  async function resolveCredentialRecord(
    errorMessage: string,
  ): Promise<
    ProviderSecretRecord & { source: "local_secret"; value: string }
  > {
    const credential = (await readProviderSecrets(input.secretPaths))
      .providers[SECRET_ID];
    if (
      !credential
      || credential.source !== "local_secret"
      || !credential.value
    ) {
      throw new Error(errorMessage);
    }
    return {
      ...credential,
      source: "local_secret",
      value: credential.value,
    };
  }

  return {
    status,
    saveCredential,
    deleteCredential,
    validateCredential,
    resolveCredential,
  };
}

async function readSnapshot(
  statePath: string,
  credentialUpdatedAt: string,
): Promise<ValidationSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<ValidationSnapshot>;
    if (
      parsed.schemaVersion !== "openpond.primeComputeValidation.v1"
      || parsed.credentialUpdatedAt !== credentialUpdatedAt
      || typeof parsed.checkedAt !== "string"
      || Number.isNaN(Date.parse(parsed.checkedAt))
      || (parsed.lastError !== null && typeof parsed.lastError !== "string")
    ) {
      return null;
    }
    const availability = parseAvailability(parsed.availability);
    if (parsed.lastError === null && availability === null) return null;
    return {
      schemaVersion: parsed.schemaVersion,
      credentialUpdatedAt,
      checkedAt: parsed.checkedAt,
      availability,
      lastError: parsed.lastError,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function parseAvailability(
  value: unknown,
): PrimeComputeProviderStatus["availability"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const availableOfferingCount = record.availableOfferingCount;
  const lowestHourlyUsd = record.lowestHourlyUsd;
  const registeredSshKeyCount = record.registeredSshKeyCount;
  if (
    typeof availableOfferingCount !== "number"
    || !Number.isInteger(availableOfferingCount)
    || availableOfferingCount < 0
    || (
      lowestHourlyUsd !== null
      && (
        typeof lowestHourlyUsd !== "number"
        || !Number.isFinite(lowestHourlyUsd)
        || lowestHourlyUsd < 0
      )
    )
    || typeof registeredSshKeyCount !== "number"
    || !Number.isInteger(registeredSshKeyCount)
    || registeredSshKeyCount < 0
  ) {
    return null;
  }
  return {
    availableOfferingCount,
    lowestHourlyUsd,
    registeredSshKeyCount,
  };
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}

function safeError(error: unknown, credential: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(credential, "[redacted]")
    .replace(/\b(?:pi|prime)[_-]?[A-Za-z0-9_-]{16,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000)
    || "Prime credential verification failed.";
}

function notConfiguredWorker(): PrimeWorkerReadiness {
  return {
    ready: false,
    status: "not_configured",
    message:
      "Connect Prime first. OpenPond will prepare the ephemeral SSH and connected-worker credentials when a training run is approved.",
    issues: [],
  };
}

function setupRequiredWorker(): PrimeWorkerReadiness {
  return {
    ready: false,
    status: "setup_required",
    message:
      "The Prime credential can be verified now. The connected Prime-RL worker runtime is the next setup step.",
    issues: [
      "Publish and pin the OpenPond worker image and capability receipt.",
      "Create ephemeral SSH, authentication, and mTLS material at approved launch time.",
    ],
  };
}
