import type { z } from "zod";
import type { WorkspaceApi } from "./workspace-api";
/** Validate the local server's own receipt model rather than projecting local
 * results into hosted job manifests with invented billing or execution fields. */
export async function localRequest<S extends z.ZodType>(
  api: WorkspaceApi,
  schema: S,
  action: string,
  payload: unknown = {},
  signal?: AbortSignal,
): Promise<z.output<S>> {
  return schema.parse(await api.local(action, payload, signal));
}
