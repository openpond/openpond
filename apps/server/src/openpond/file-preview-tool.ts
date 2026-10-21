import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FilePreviewRequest, RuntimeEvent } from "@openpond/contracts/runtime";
import type { Session } from "@openpond/contracts";
import type { ModelToolDefinition } from "./model-tool-registry.js";
import { event } from "../utils.js";

export const FILE_PREVIEW_INSTRUCTIONS = "Use openpond_show_file to display a file in the app when the user asks to see it, or when presenting a document, image, or other deliverable you have created or updated. Supply the actual filesystem path with spaces intact. Do not open every incidental source file. The tool requests a preview in this chat; final-answer file links remain useful for reopening it.";

export function createFilePreviewTool(deps: {
  resolveCwd: (session: Session) => Promise<string | null>;
  appendEvent: (event: RuntimeEvent) => Promise<unknown>;
}): ModelToolDefinition {
  return {
    name: "openpond_show_file",
    description: "Show an existing file in this chat's file preview panel (HTML and video use the browser). Use for requested files and completed or updated deliverables. Pass a plain filesystem path, not a URL-encoded Markdown link. Does not attach or send the file. Only a currently visible chat opens the preview.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Exact absolute path or path relative to this chat's workspace. Preserve spaces and literal percent signs." },
        source: { type: "boolean", description: "Show HTML source instead of rendering it. Defaults to false." },
      },
      required: ["path"],
    },
    enabled: ({ session }) => !session.systemKind,
    execute: async ({ session, turnId, callId, args, signal }) => {
      signal.throwIfAborted();
      if (typeof args.path !== "string" || !args.path.trim() || /[\0\r\n]/.test(args.path)) throw new Error("An existing file path is required.");
      if (args.source !== undefined && typeof args.source !== "boolean") throw new Error("source must be a boolean.");
      const source = args.source === true;
      const rawPath = args.path;
      let request: FilePreviewRequest;
      if (["sandbox", "sandbox_app", "sandbox_template"].includes(session.workspaceKind ?? "")) {
        if (!session.workspaceId) throw new Error("This chat has no active sandbox.");
        const resolved = path.posix.resolve("/workspace", rawPath);
        if (!resolved.startsWith("/workspace/")) throw new Error("Sandbox previews must stay under /workspace.");
        request = { target: "sandbox", sandboxId: session.workspaceId, path: resolved, source };
      } else {
        const localPath = rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath.startsWith("~/") ? path.join(homedir(), rawPath.slice(2)) : rawPath;
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(localPath)) throw new Error("Use a filesystem path for file previews.");
        const cwd = path.isAbsolute(localPath) ? null : await deps.resolveCwd(session) ?? session.cwd;
        if (!path.isAbsolute(localPath) && !cwd) throw new Error("Use an absolute file path for this chat.");
        const resolved = path.resolve(cwd ?? "/", localPath);
        if (!(await stat(resolved)).isFile()) throw new Error("Choose a file to preview.");
        request = { target: "local", path: resolved, source };
      }
      signal.throwIfAborted();
      await deps.appendEvent(event({ sessionId: session.id, turnId, name: "file.preview_requested", source: "server", data: request }));
      return { toolCallId: callId, name: "openpond_show_file", ok: true,
        contentText: `Requested a preview of ${request.path} in this chat.`, data: request };
    },
  };
}
