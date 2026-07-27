const DEFAULT_BASE_URL = "https://api.primeintellect.ai";

export type PrimeCredentialProbeResult = {
  checkedAt: string;
  availableOfferingCount: number;
  lowestHourlyUsd: number | null;
  registeredSshKeyCount: number;
};

export type PrimeCredentialProbeOptions = {
  apiKey: string;
  request?: typeof fetch;
  baseUrl?: string;
  now?: () => Date;
};

export type PrimeSshKey = {
  id: string;
  name: string;
  publicKey: string;
  isPrimary: boolean;
};

/**
 * Verifies a Prime credential without provisioning or changing provider state.
 * Only aggregate availability and SSH-key counts leave this boundary.
 */
export async function probePrimeCredential(
  options: PrimeCredentialProbeOptions,
): Promise<PrimeCredentialProbeResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Prime API key is empty.");
  const request = options.request ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const availabilityQuery = new URLSearchParams({
    gpu_type: "H100_80GB",
    gpu_count: "1",
    security: "secure_cloud",
    page: "1",
    page_size: "100",
  });

  const [availability, sshKeys] = await Promise.all([
    primeJson({
      apiKey,
      request,
      url: `${baseUrl}/api/v1/availability/gpus?${availabilityQuery}`,
      label: "availability",
    }),
    primeJson({
      apiKey,
      request,
      url: `${baseUrl}/api/v1/ssh_keys/?offset=0&limit=100`,
      label: "SSH keys",
    }),
  ]);

  const matchingOfferings = arrayField(availability, "items")
    .filter(isMatchingOffering);
  const hourlyPrices = matchingOfferings
    .map((item) => nestedNumber(item, "prices", "onDemand"))
    .filter((value): value is number => value !== null);

  return {
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    availableOfferingCount: matchingOfferings.length,
    lowestHourlyUsd:
      hourlyPrices.length > 0 ? Math.min(...hourlyPrices) : null,
    registeredSshKeyCount:
      nonnegativeIntegerField(sshKeys, "total_count")
      ?? arrayField(sshKeys, "data").length,
  };
}

export async function listPrimeSshKeys(
  options: Pick<
    PrimeCredentialProbeOptions,
    "apiKey" | "request" | "baseUrl"
  >,
): Promise<PrimeSshKey[]> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Prime API key is empty.");
  const request = options.request ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const payload = await primeJson({
    apiKey,
    request,
    url: `${baseUrl}/api/v1/ssh_keys/?offset=0&limit=100`,
    label: "SSH keys",
  });
  return arrayField(payload, "data").map((value, index) => {
    const key = object(value, `Prime SSH key ${index + 1}`);
    const id = requiredString(key.id, `Prime SSH key ${index + 1} ID`);
    const publicKey = requiredString(
      key.publicKey,
      `Prime SSH key ${id} public key`,
    );
    return {
      id,
      name:
        typeof key.name === "string" && key.name.trim()
          ? key.name.trim()
          : id,
      publicKey,
      isPrimary: key.isPrimary === true,
    };
  });
}

async function primeJson(input: {
  apiKey: string;
  request: typeof fetch;
  url: string;
  label: string;
}): Promise<Record<string, unknown>> {
  const response = await input.request(input.url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = sanitizeError(text, input.apiKey);
    throw new Error(
      `Prime API ${input.label} check failed (${response.status})${
        detail ? `: ${detail}` : "."
      }`,
    );
  }
  if (!text) throw new Error(`Prime API ${input.label} check returned an empty response.`);
  try {
    return object(JSON.parse(text), `Prime API ${input.label} response`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Prime API ${input.label} check returned invalid JSON.`);
    }
    throw error;
  }
}

function isMatchingOffering(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const prices =
    item.prices && typeof item.prices === "object" && !Array.isArray(item.prices)
      ? item.prices as Record<string, unknown>
      : {};
  return (
    item.gpuType === "H100_80GB"
    && item.gpuCount === 1
    && item.security === "secure_cloud"
    && String(item.stockStatus).toLowerCase() === "available"
    && prices.isVariable !== true
    && (item.prepaidTime === null || item.prepaidTime === undefined)
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`Prime API response field ${key} must be an array.`);
  return field;
}

function nestedNumber(
  value: Record<string, unknown>,
  outerKey: string,
  innerKey: string,
): number | null {
  const outer = value[outerKey];
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return null;
  const number = (outer as Record<string, unknown>)[innerKey];
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? number
    : null;
}

function nonnegativeIntegerField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const field = value[key];
  return typeof field === "number"
    && Number.isInteger(field)
    && field >= 0
    ? field
    : null;
}

function sanitizeError(value: string, apiKey: string): string {
  return value
    .replaceAll(apiKey, "[redacted]")
    .replace(/\b(?:pi|prime)[_-]?[A-Za-z0-9_-]{16,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
