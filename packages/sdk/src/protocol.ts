export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export const OPENPOND_TRAINING_PROTOCOL_MAJOR = 2 as const;
export const OPENPOND_TRAINING_MEDIA_TYPE =
  "application/vnd.openpond.training+json;version=2" as const;
export const OPENPOND_MODEL_PROJECT_MEDIA_TYPE =
  "application/vnd.openpond.model-project+json;version=2" as const;

export const TRAINING_JOB_SUBMISSION_MAX_BYTES = 1_048_576;
export const TRAINING_INPUT_ARTIFACT_MAX_BYTES = 67_108_864;
export const TRAINING_API_RESPONSE_MAX_BYTES = 8_388_608;
export const MODEL_PROJECT_SYNC_MAX_BYTES = 524_288;
export const MODEL_PROJECT_API_RESPONSE_MAX_BYTES = 8_388_608;

export class OpenPondProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenPondProtocolError";
    this.code = code;
  }
}

/**
 * Deterministic JSON used for content-addressed OpenPond protocol objects.
 * Object keys are sorted by Unicode code point, arrays retain their authored
 * order, and non-JSON/non-finite values are rejected rather than coerced.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value));
}

export function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export async function canonicalSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertCanonicalPayloadSize(
  value: unknown,
  maximumBytes: number,
  label: string,
): void {
  const actualBytes = canonicalJsonByteLength(value);
  if (actualBytes > maximumBytes) {
    throw new OpenPondProtocolError(
      "payload_too_large",
      `${label} is ${actualBytes} bytes; the maximum is ${maximumBytes} bytes.`,
    );
  }
}

export function parseBoundedJson(
  text: string,
  maximumBytes: number,
  label: string,
): unknown {
  const actualBytes = new TextEncoder().encode(text).byteLength;
  if (actualBytes > maximumBytes) {
    throw new OpenPondProtocolError(
      "response_too_large",
      `${label} is ${actualBytes} bytes; the maximum is ${maximumBytes} bytes.`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenPondProtocolError(
      "invalid_json",
      `${label} was not valid JSON.`,
    );
  }
}

/** Bound the wire body while consuming it, before allocating the complete JSON
 * string. Reader cleanup must never replace the original transport/JSON error. */
export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return parseBoundedJson("", maximumBytes, label);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        throw new OpenPondProtocolError(
          "response_too_large",
          `${label} exceeds the maximum of ${maximumBytes} bytes.`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return parseBoundedJson(text, maximumBytes, label);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the primary failure. */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* Never mask a transport/parse failure. */ }
  }
}

function normalizeCanonicalJson(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpenPondProtocolError(
        "non_json_value",
        "Canonical JSON cannot contain a non-finite number.",
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCanonicalJson(entry));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OpenPondProtocolError(
        "non_json_value",
        "Canonical JSON accepts only plain objects.",
      );
    }
    const result: Record<string, CanonicalJsonValue> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new OpenPondProtocolError(
          "non_json_value",
          `Canonical JSON cannot contain ${typeof entry} at ${key}.`,
        );
      }
      result[key] = normalizeCanonicalJson(entry);
    }
    return result;
  }
  throw new OpenPondProtocolError(
    "non_json_value",
    `Canonical JSON cannot contain ${typeof value}.`,
  );
}
