import { apiFetch, type ClientConnection } from "../api/api-client";

export const isHtmlFilePath = (path: string) => /\.html?(?:[?#].*)?$/i.test(path);

export async function htmlPreviewUrl(connection: ClientConnection, workspaceId: string, path: string, source: "local" | "sandbox" = "local"): Promise<string> {
  const result = await apiFetch<{ url: string }>(connection, `/v1/${source === "sandbox" ? "sandboxes" : "workspaces"}/${encodeURIComponent(workspaceId)}/html-preview`, {
    method: "POST", body: JSON.stringify({ path }),
  });
  return result.url;
}

export async function htmlContentPreviewUrl(connection: ClientConnection, name: string, content: string): Promise<string> {
  const result = await apiFetch<{ url: string }>(connection, "/v1/html-previews", { method: "POST", body: JSON.stringify({ name, content }) });
  return result.url;
}
