import { useMemo, type ReactNode } from "react";
import type { RuntimeEvent } from "@openpond/contracts";
import { useQuery } from "@tanstack/react-query";
import { connectionQueryScope } from "../../lib/query-scope";
import { api, type ClientConnection } from "../../api";
import { WorkspaceFileThumbnail } from "../workspace-diff/WorkspaceFileThumbnail";
import type { ChatMessage } from "../../lib/app-models";
import { ActivityFileArtifact } from "../chat/ActivityFileArtifact";
import { visibleChatFileArtifacts, workOutputsFromEvents } from "./WorkSidebarPanel";

export function RightSidebarOverview({ messages, events, actions, onOpenFile, connection, workspaceId, sandboxId, sessionId }: {
  sessionId: string | null;
  connection: ClientConnection | null;
  workspaceId: string | null;
  sandboxId?: string | null;
  messages: ChatMessage[];
  events: RuntimeEvent[];
  actions: ReactNode;
  onOpenFile: (path: string) => void;
}) {
  const published = useMemo(() => workOutputsFromEvents(events), [events]);
  const outputVersion = published.map(output => `${output.id}:${output.revision}`).join(",");
  const saved = useQuery({
    queryKey: ["thread-output-files", connectionQueryScope(connection), sessionId, outputVersion],
    enabled: Boolean(connection && sessionId),
    queryFn: async () => (await api.workOutputs(connection!)).outputs.filter(output => output.sourceTaskId === sessionId),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const files = useMemo(() => {
    const artifacts = new Map(visibleChatFileArtifacts(messages).map(file => [file.path, { ...file, contentType: "application/octet-stream" }]));
    const seenOutputs = new Set<string>();
    for (const output of [...published, ...(saved.data ?? [])]) {
      if (seenOutputs.has(output.id)) continue;
      seenOutputs.add(output.id);
      if (output.kind !== "file" || output.location.kind !== "local") continue;
      artifacts.set(output.location.path, { path: output.location.path, title: output.title, sizeBytes: output.sizeBytes, contentType: output.contentType });
    }
    return [...artifacts.values()];
  }, [messages, published, saved.data]);

  return (
    <div className="right-sidebar-overview">
      {files.length ? (
        <section className="right-sidebar-overview-files" aria-label="Thread files">
          <h3>Files</h3>
          {files.map(file => <ActivityFileArtifact key={file.path} artifact={file} onOpenFileInSidebar={onOpenFile}
            preview={<WorkspaceFileThumbnail path={file.path} connection={connection} workspaceId={workspaceId} sandboxId={sandboxId} />} />)}
        </section>
      ) : null}
      <section className="right-sidebar-overview-tools" aria-label="Tools">
        <h3>Tools</h3>
        {actions}
      </section>
    </div>
  );
}
