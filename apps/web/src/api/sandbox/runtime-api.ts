import type { SandboxRecordResponse } from "../../lib/sandbox-types";
import { apiFetch, type ClientConnection } from "../api-client";

export const sandboxRuntimeApi = {
  sandbox: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxRecordResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    ),
};
