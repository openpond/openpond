const SQLITE_HEALTH_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

export type SqliteHealthRetry = {
  attempt: number;
  retryDelayMs: number;
  error: unknown;
};

export class SqliteIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteIntegrityError";
  }
}

export function isConfirmedSqliteCorruption(error: unknown): boolean {
  if (error instanceof SqliteIntegrityError) return true;
  const code = sqliteErrorCode(error);
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  const message = sqliteErrorMessage(error);
  return message.includes("database disk image is malformed") ||
    message.includes("file is not a database") ||
    message.includes("file is encrypted or is not a database");
}

export async function retrySqliteHealthCheck(input: {
  check: () => Promise<void>;
  onRetry?: (retry: SqliteHealthRetry) => void;
}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await input.check();
      return;
    } catch (error) {
      const retryDelayMs = SQLITE_HEALTH_RETRY_DELAYS_MS[attempt];
      if (!isTransientSqliteAvailabilityError(error) || retryDelayMs === undefined) throw error;
      input.onRetry?.({ attempt: attempt + 1, retryDelayMs, error });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function sqliteErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code.toUpperCase() : null;
}

function sqliteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function isTransientSqliteAvailabilityError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const message = sqliteErrorMessage(error);
  return message.includes("database is locked") || message.includes("database is busy");
}
