/** Picker reads must finish independently of a stalled hosted connection. */
export const chatCatalogFetch: typeof fetch = (url, init) => fetch(url, {
  ...init,
  redirect: "error",
  signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(init?.signal ? [init.signal] : [])]),
});

export function catalogFailure(source: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : "Request failed";
  return `${source}: ${detail.slice(0, 500)}`;
}
