import { shell } from "electron";
import { fileURLToPath } from "node:url";

export function normalizeBrowserUrl(value: string, explicitFile = false): string {
  const trimmed = value.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!trimmed || /\s/.test(trimmed) || /^(javascript|data):/i.test(trimmed)) {
    throw new Error("Unsupported browser URL.");
  }
  if (/^https?:\/\//i.test(trimmed)) return parseUrl(trimmed, ["http:", "https:"]);
  if (/^file:\/\//i.test(trimmed) && explicitFile) return parseUrl(trimmed, ["file:"]);
  if (/^(localhost|\[::1\]|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return parseUrl(`http://${trimmed}`, ["http:"]);
  }
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:[:/?#].*)?$/i.test(trimmed)) {
    return parseUrl(`https://${trimmed}`, ["https:"]);
  }
  throw new Error("Unsupported browser URL.");
}

export async function openUrlExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    await shell.openPath(fileURLToPath(parsed));
    return;
  }
  if (parsed.protocol === "javascript:" || parsed.protocol === "data:") return;
  await shell.openExternal(url);
}

export function partitionForConversation(conversationId: string): string {
  return `persist:openpond-browser-${Buffer.from(conversationId).toString("base64url").slice(0, 120)}`;
}

function parseUrl(value: string, protocols: string[]): string {
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) throw new Error("Unsupported browser URL.");
  return url.toString();
}
