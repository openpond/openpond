import { useMemo, type ReactNode } from "react";
import type { RuntimeEvent, SessionFileArtifact } from "@openpond/contracts";
import { useQuery } from "@tanstack/react-query";
import { connectionQueryScope } from "../../lib/query-scope";
import { api, type ClientConnection } from "../../api";
import { NewTabBrowserToolbar } from "../browser/NewTabBrowserToolbar";
import { WorkspaceFileThumbnail } from "../workspace-diff/WorkspaceFileThumbnail";
import type { ChatMessage } from "../../lib/app-models";
import { ActivityFileArtifact } from "../chat/ActivityFileArtifact";
import { visibleChatFileArtifacts, workOutputsFromEvents } from "./WorkSidebarPanel";

export function RightSidebarOverview({ messages, events, actions, onOpenFile, connection, workspaceId, sandboxId, sessionId, conversationId, onOpenBrowser }: {
  conversationId: string;
  onOpenBrowser: () => void;
  sessionId: string | null;
  connection: ClientConnection | null;
  workspaceId: string | null;
  sandboxId?: string | null;
  messages: ChatMessage[];
  events: RuntimeEvent[];
  actions: ReactNode;
  onOpenFile: (path: string, options?: { sandboxId?: string | null; local?: boolean }) => void;
}) {
  const published = useMemo(() => workOutputsFromEvents(events), [events]);
  const outputVersion = events.filter(event => event.name === "workspace_action_result" || event.name === "tool.completed" || event.name === "turn.completed").at(-1)?.id ?? "";
  const connectionScope = connectionQueryScope(connection);
  const saved = useQuery({
    queryKey: ["thread-output-files", connectionScope, sessionId, outputVersion],
    placeholderData: (previous, query) => query?.queryKey[1] === connectionScope && query.queryKey[2] === sessionId ? previous : undefined,
    enabled: Boolean(connection && sessionId),
    queryFn: async () => (await api.sessionFiles(connection!, sessionId!)).files,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const files = useMemo(() => {
    // The persisted index owns source identity; old transcript artifacts must
    // never be relabeled with the conversation's newly selected sandbox.
    if (saved.data) return saved.data;
    const artifacts = new Map<string, SessionFileArtifact>(visibleChatFileArtifacts(messages).map(file => [`${sandboxId ?? "local"}:${file.path}`, { ...file, contentType: "application/octet-stream", sandboxId: sandboxId ?? null }]));
    const seenOutputs = new Set<string>();
    for (const output of published) {
      if (seenOutputs.has(output.id)) continue;
      seenOutputs.add(output.id);
      if (output.kind !== "file" || output.location.kind !== "local") continue;
      artifacts.set(`local:${output.location.path}`, { path: output.location.path, title: output.title, sizeBytes: output.sizeBytes, contentType: output.contentType, sandboxId: null });
    }
    return [...artifacts.values()].reverse();
  }, [messages, published, sandboxId, saved.data]);

  return (
    <div className="right-sidebar-new-tab">
      <NewTabBrowserToolbar conversationId={conversationId} onOpenBrowser={onOpenBrowser} />
      <div className="right-sidebar-overview">
      {files.length ? (
        <section className="right-sidebar-overview-files" aria-label="Thread files">
          <h3>Files</h3>
          {files.map(file => <ActivityFileArtifact key={`${file.sandboxId ?? "local"}:${file.path}`} artifact={file}
            onOpenFileInSidebar={path => onOpenFile(path, { sandboxId: file.sandboxId, local: !file.sandboxId })}
            preview={<WorkspaceFileThumbnail revision={file.revision} path={file.path} connection={connection} workspaceId={workspaceId} sandboxId={file.sandboxId} />} />)}
        </section>
      ) : null}
      <section className="right-sidebar-overview-tools" aria-label="Tools">
        <h3>Tools</h3>
        {actions}
      </section>
      </div>
    </div>
  );
}
