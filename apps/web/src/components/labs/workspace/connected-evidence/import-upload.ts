import { CONNECTED_EVIDENCE_LIMITS } from "@openpond/evals/connected-evidence";
import { z } from "zod";
import { connectedCommand } from "./client";
import type { WorkspaceApi } from "../workspace-api";

function base64(bytes: Uint8Array) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return btoa(text);
}
/** File bytes remain local until explicit Preview. Upload parts are private and content addressed. */
export async function uploadAgentFiles(api: WorkspaceApi, files: File[], onProgress: (completed: number, total: number) => void) {
  if (!files.length || files.length > CONNECTED_EVIDENCE_LIMITS.files || files.reduce((total, file) => total + file.size, 0) > CONNECTED_EVIDENCE_LIMITS.sourceBytes)
    throw new Error("Select up to 100 files totaling 32 MiB or less.");
  const envelope = [];
  for (const file of files) envelope.push({ path: file.webkitRelativePath || file.name, encoding: file.name.endsWith(".zst") ? "zstd" : "utf8",
    base64: base64(new Uint8Array(await file.arrayBuffer())) });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const parts = Math.ceil(bytes.length / 250_000);
  const receipt = z.object({ teamId: z.string(), hash: z.string(), parts: z.number(), index: z.number() }).strict();
  for (let index = 0; index < parts; index++) {
    const value = await connectedCommand(api, "upload", { hash, parts, index, base64: base64(bytes.subarray(index * 250_000, (index + 1) * 250_000)) }, receipt);
    if (value.teamId !== api.teamId || value.hash !== hash || value.parts !== parts || value.index !== index) throw new Error("Uploaded part identity differs from the selected files.");
    onProgress(index + 1, parts);
  }
  return { hash, parts };
}
