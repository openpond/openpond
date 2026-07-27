import type {
  SandboxFileDownloadResponse,
  SandboxFileListResponse,
  SandboxFileUploadResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  base64ToText,
  type ClientConnection,
} from "../api-client";

export type SandboxSourcePreserveResponse = {
  preserved: boolean;
  preservedSha: string | null;
  runtime?: unknown;
  patch?: unknown;
  account?: unknown;
};

export const sandboxFileApi = {
  sandboxFiles: (
    connection: ClientConnection,
    sandboxId: string,
    input: { path?: string; recursive?: boolean; maxEntries?: number } = {},
  ) => {
    const query = new URLSearchParams({ list: "1" });
    if (input.path) query.set("path", input.path);
    if (input.recursive !== undefined) query.set("recursive", String(input.recursive));
    if (input.maxEntries !== undefined) query.set("maxEntries", String(input.maxEntries));
    return apiFetch<SandboxFileListResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
    );
  },
  sandboxUploadFile: (
    connection: ClientConnection,
    sandboxId: string,
    input: { path: string; contents: string },
  ) =>
    apiFetch<SandboxFileUploadResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  preserveSandboxSource: (
    connection: ClientConnection,
    sandboxId: string,
    input: { message?: string } = {},
  ) =>
    apiFetch<SandboxSourcePreserveResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/preserve-source`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandboxDownloadFile: async (
    connection: ClientConnection,
    sandboxId: string,
    path: string,
    input: { offsetBytes?: number; maxBytes?: number } = {},
  ) => {
    const query = new URLSearchParams({ path });
    if (input.offsetBytes !== undefined) query.set("offsetBytes", String(input.offsetBytes));
    if (input.maxBytes !== undefined) query.set("maxBytes", String(input.maxBytes));
    const payload = await apiFetch<SandboxFileDownloadResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
    );
    return {
      ...payload,
      contents: payload.file.isBinary ? "" : base64ToText(payload.file.contentsBase64),
    };
  },
};
