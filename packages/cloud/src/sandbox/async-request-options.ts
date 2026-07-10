import type { SandboxAsyncRequestOptions } from "./types/index.js";

export function asyncRequestHeaders(
  options: SandboxAsyncRequestOptions = {}
): HeadersInit | undefined {
  return options.async || options.respondAsync
    ? { Prefer: "respond-async" }
    : undefined;
}
