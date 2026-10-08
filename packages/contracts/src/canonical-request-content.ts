/** Stable JSON bytes shared by signed requests and durable local identities. */
export function canonicalRequestContent(method: "POST", path: string, payload: unknown): string {
  function canonical(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().map(key =>
        [key, canonical((value as Record<string, unknown>)[key])]));
    }
    throw new Error("canonical_payload_not_json");
  }
  return JSON.stringify([method, path, canonical(payload)]);
}
