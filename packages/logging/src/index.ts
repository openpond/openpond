import { promises as fs } from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

export type LoggerOptions = {
  channel: string;
  logDir: string;
  filename?: string;
  metadata?: Record<string, unknown>;
  maxBytes?: number;
  maxFiles?: number;
};

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  filePath: string;
};

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const SECRET_KEY_PATTERN = /authorization|api[_-]?key|token|session[_-]?token|secret|password/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function redact(value: unknown): unknown {
  if (value instanceof Error) return redact(serializeError(value));
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(item);
  }
  return redacted;
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await fs.rm(to, { force: true });
    await fs.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(URL_PATTERN, (match) => redactUrl(match));
}

function redactUrl(value: string): string {
  const { url, suffix } = splitUrlSuffix(value);
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "[REDACTED]";
      parsed.password = "[REDACTED]";
    }
    redactSearchParams(parsed.searchParams);
    if (parsed.hash) parsed.hash = redactHash(parsed.hash.slice(1));
    return `${parsed.toString()}${suffix}`;
  } catch {
    return value;
  }
}

function splitUrlSuffix(value: string): { url: string; suffix: string } {
  let url = value;
  let suffix = "";
  while (/[),.;!?]$/.test(url)) {
    suffix = `${url.slice(-1)}${suffix}`;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function redactSearchParams(params: URLSearchParams): void {
  for (const key of Array.from(params.keys())) {
    if (SECRET_KEY_PATTERN.test(key)) params.set(key, "[REDACTED]");
  }
}

function redactHash(value: string): string {
  if (!value.includes("=")) return SECRET_KEY_PATTERN.test(value) ? "[REDACTED]" : value;
  const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
  redactSearchParams(params);
  return params.toString();
}

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const filePath = path.join(options.logDir, options.filename ?? `${options.channel}.log`);
  let queue = Promise.resolve();

  async function rotateIfNeeded(nextBytes: number): Promise<void> {
    let size = 0;
    try {
      size = (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size + nextBytes <= maxBytes) return;

    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      await renameIfExists(`${filePath}.${index}`, `${filePath}.${index + 1}`);
    }
    await renameIfExists(filePath, `${filePath}.1`);
  }

  function write(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    const record = {
      ts: new Date().toISOString(),
      level,
      channel: options.channel,
      message,
      pid: process.pid,
      platform: process.platform,
      ...(options.metadata ?? {}),
      ...fields,
    };
    const line = `${JSON.stringify(redact(record))}\n`;
    queue = queue
      .then(async () => {
        await fs.mkdir(options.logDir, { recursive: true });
        await rotateIfNeeded(Buffer.byteLength(line, "utf8"));
        await fs.appendFile(filePath, line, "utf8");
      })
      .catch((error) => {
        console.error("OpenPond logger failed", error);
      });
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    flush: () => queue,
    filePath,
  };
}
