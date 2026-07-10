import type { CodexStatus } from "@openpond/contracts";

type CodexProbe = {
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  authHealth: CodexStatus["authHealth"];
  account: CodexStatus["account"];
  error: string | null;
};

export type CodexStatusService = {
  get(): CodexStatus;
  refresh(force?: boolean): Promise<CodexStatus>;
  set(status: CodexStatus): void;
};

export function createCodexStatusService(options: {
  detect: () => Promise<CodexProbe>;
  now?: () => number;
  ttlMs?: number;
}): CodexStatusService {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  let status = emptyCodexStatus();
  let refreshedAt = 0;
  let inFlight: Promise<CodexStatus> | null = null;

  return {
    get: () => status,
    set(next) {
      status = next;
    },
    refresh(force = false) {
      if (!force && refreshedAt > 0 && now() - refreshedAt < ttlMs) return Promise.resolve(status);
      if (inFlight) return inFlight;
      const operation = options.detect().then((probe) => {
        status = {
          available: probe.available,
          binaryPath: probe.binaryPath,
          version: probe.version,
          authHealth: probe.authHealth,
          account: probe.account,
          appServer: {
            status: status.appServer.status,
            lastError: probe.error,
          },
        };
        refreshedAt = now();
        return status;
      }).finally(() => {
        if (inFlight === operation) inFlight = null;
      });
      inFlight = operation;
      return operation;
    },
  };
}

function emptyCodexStatus(): CodexStatus {
  return {
    available: false,
    binaryPath: null,
    version: null,
    authHealth: "unknown",
    account: null,
    appServer: { status: "idle", lastError: null },
  };
}
