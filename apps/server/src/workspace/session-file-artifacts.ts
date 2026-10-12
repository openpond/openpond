import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { SessionFileArtifactSchema, type RuntimeEvent, type Session, type SessionFileArtifact } from "@openpond/contracts";

type FileContext = { cwd: string | null; sandboxId: string | null };
/** File references belong to persisted conversations, rather than the current
 * workspace or the transcript page presently loaded in the renderer. */
export function sessionFileArtifacts(session: Session, events: RuntimeEvent[]): SessionFileArtifact[] {
  const files = new Map<string, SessionFileArtifact>();
  const deleted = new Set<string>();
  const positions = new Map<string, number>();
  let position = 0;
  const messages = new Map<string, FileContext & { text: string; revision: string; position: number }>();
  let context: FileContext = { cwd: session.cwd, sandboxId: cloudSandbox(session) };
  function add(rawPath: string, title: unknown, contentType: string, sizeBytes: unknown, source: FileContext, deleting = false, revision?: string, filePosition = position) {
    if (/^(?!file:)[a-z][a-z\d+.-]+:/i.test(rawPath.replace(/^[A-Za-z]:[\\/]/, ""))) return;
    let target = rawPath;
    try { if (target.startsWith("file://")) target = fileURLToPath(target); } catch { return; }
    if (!source.sandboxId) {
      if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
      else if (!path.isAbsolute(target) && !path.win32.isAbsolute(target)) {
        if (!source.cwd) return;
        target = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(source.cwd) ? path.win32.resolve(source.cwd, target) : path.resolve(source.cwd, target);
      }
    }
    const key = `${source.sandboxId ?? "local"}:${target}`;
    if (deleting) { files.delete(key); deleted.add(key); return; }
    if (deleted.has(key) || filePosition < (positions.get(key) ?? -1)) return;
    const parsed = SessionFileArtifactSchema.safeParse({ path: target,
      title: typeof title === "string" && title.trim() ? title : target.split(/[\\/]/).pop(),
      contentType, revision, sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null, sandboxId: source.sandboxId });
    if (parsed.success) { files.set(key, parsed.data); positions.set(key, filePosition); }
  }
  for (const event of events) {
    position += 1;
    const data = record(event.data);
    const snapshot = record(data?.session);
    if ((event.name === "session.started" || event.name === "session.updated") && snapshot)
      context = { cwd: typeof snapshot.cwd === "string" ? snapshot.cwd : null, sandboxId: cloudSandbox(snapshot) };
    if (event.name === "assistant.delta") {
      const id = String(data?.nativeMessageId ?? data?.messageId ?? data?.itemId ?? event.turnId ?? event.id);
      const prior = messages.get(id) ?? { ...context, text: "", revision: event.id, position };
      const text = event.output ?? (typeof data?.delta === "string" ? data.delta : "");
      messages.set(id, { ...prior, revision: event.id, position, text: data?.nativeMessageSnapshot ? text : prior.text + text });
      continue;
    }
    if (event.name !== "workspace_action_result" && event.name !== "tool.completed") continue;
    if (event.action === "work_output_read") continue;
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 8 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(child => collect(child, depth + 1)); return; }
      const row = value as Record<string, unknown>;
      const location = record(row.location);
      const source = location?.kind === "local" ? { ...context, sandboxId: null } : context;
      const rawPath = location?.kind === "local" && typeof location.path === "string" ? location.path
        : typeof row.path === "string" ? row.path : typeof row.artifactRef === "string" ? row.artifactRef : null;
      const mime = typeof row.contentType === "string" ? row.contentType : typeof row.mimeType === "string" ? row.mimeType : null;
      if (rawPath && mime) add(rawPath, row.title ?? row.name, mime, row.sizeBytes, source,
        event.action === "work_output_delete" && event.status === "completed", event.id);
      Object.values(row).forEach(child => collect(child, depth + 1));
    };
    collect(event.data);
  }
  // Native agents also create files through shell tools and publish them as
  // Markdown links; these are durable references even without an output tool.
  for (const message of messages.values()) {
    for (const match of message.text.matchAll(/!?\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      let target = match[2] ?? match[3] ?? "";
      try { target = decodeURI(target); } catch { continue; }
      if (!/\.[a-z\d]{1,12}$/i.test(target) || /[?#]/.test(target)) continue;
      const extension = target.split(".").pop()?.toLowerCase();
      const mime = ({ pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf",
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
        md: "text/markdown", txt: "text/plain" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
      add(target, match[1], mime, null, message, false, message.revision, message.position);
    }
  }
  return [...files.entries()].sort(([a], [b]) => positions.get(b)! - positions.get(a)!).map(([, file]) => file);
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function cloudSandbox(session: Pick<Session, "workspaceKind" | "workspaceId"> | Record<string, unknown>): string | null {
  return ["sandbox", "sandbox_app", "sandbox_template"].includes(String(session.workspaceKind)) && typeof session.workspaceId === "string" ? session.workspaceId : null;
}
