import { useMemo, type ReactNode } from "react";
import type { RuntimeEvent } from "@openpond/contracts";
import type { ChatMessage } from "../../lib/app-models";
import { ActivityFileArtifact } from "../chat/ActivityFileArtifact";
import { visibleChatFileArtifacts, workOutputsFromEvents } from "./WorkSidebarPanel";

export function RightSidebarOverview({ messages, events, actions, onOpenFile }: {
  messages: ChatMessage[];
  events: RuntimeEvent[];
  actions: ReactNode;
  onOpenFile: (path: string) => void;
}) {
  const files = useMemo(() => {
    const artifacts = new Map(visibleChatFileArtifacts(messages).map(file => [file.path, { ...file, contentType: "application/octet-stream" }]));
    const seenOutputs = new Set<string>();
    for (const output of workOutputsFromEvents(events)) {
      if (seenOutputs.has(output.id)) continue;
      seenOutputs.add(output.id);
      if (output.kind !== "file" || output.location.kind !== "local") continue;
      artifacts.set(output.location.path, { path: output.location.path, title: output.title, sizeBytes: output.sizeBytes, contentType: output.contentType });
    }
    return [...artifacts.values()];
  }, [messages, events]);

  return (
    <div className="right-sidebar-overview">
      <div className="right-sidebar-overview-content">
        {files.length ? (
          <section className="right-sidebar-overview-files" aria-label="Thread files">
            {files.map(file => <ActivityFileArtifact key={file.path} artifact={file} onOpenFileInSidebar={onOpenFile} />)}
          </section>
        ) : null}
        <section className="right-sidebar-overview-tools" aria-label="Tools">
          {actions}
        </section>
      </div>
    </div>
  );
}
