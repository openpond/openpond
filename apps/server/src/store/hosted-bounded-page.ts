/** Retry a read page at a smaller size when the private JSONL response cap is hit. */
export async function hostedBoundedPage<T>(
  requestedLimit: number,
  read: (limit: number) => Promise<T>,
): Promise<T> {
  let limit = requestedLimit;
  for (;;) {
    try {
      return await read(limit);
    } catch (error) {
      if (!isOversizeResponse(error) || limit <= 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
}

function isOversizeResponse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "Host storage response is too large."
    || error.message === "Host storage request failed: host_storage_response_too_large";
}
