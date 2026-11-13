import type { ReactNode } from "react";
import type { ActivityItem } from "../../lib/app-models";
import { useFilePathContextMenu } from "../common/FilePathContextMenu";
import { revealLocalFile } from "../../lib/desktop-files";
import { FileText, FolderOpen } from "../icons";

type FileArtifact = NonNullable<ActivityItem["artifacts"]>[number];

export function ActivityFileArtifact({
  artifact,
  onOpenFileInSidebar,
  preview,
}: {
  artifact: FileArtifact;
  onOpenFileInSidebar?: (path: string) => void;
  preview?: ReactNode;
}) {
  const { openFilePathMenu, filePathMenu } = useFilePathContextMenu();

  return (
    <>
      <div
        className="activity-artifact"
        title={artifact.path}
        onClick={
          onOpenFileInSidebar
            ? (event) => {
                if (!(event.target as Element).closest("button"))
                  onOpenFileInSidebar(artifact.path);
              }
            : undefined
        }
        onContextMenu={(event) => openFilePathMenu(event, artifact.path, artifact.title)}
      >
        {onOpenFileInSidebar ? (
          <button
            aria-label={`Open ${artifact.title} in right sidebar`}
            className="activity-artifact-name"
            type="button"
            onClick={() => onOpenFileInSidebar(artifact.path)}
          >
            {preview ? (
              <span className="activity-artifact-preview" aria-hidden>
                {preview}
              </span>
            ) : (
              <FileText aria-hidden size={14} />
            )}
            <strong>{artifact.title}</strong>
          </button>
        ) : (
          <span className="activity-artifact-name">
            <FileText aria-hidden size={14} />
            <strong>{artifact.title}</strong>
          </span>
        )}
        <span className="activity-artifact-actions">
          <button
            aria-label={`Show ${artifact.title} in file browser`}
            data-tooltip="Open in file browser"
            type="button"
            onClick={() => void revealLocalFile(artifact.path)}
          >
            <FolderOpen aria-hidden size={14} />
          </button>
        </span>
      </div>
      {filePathMenu}
    </>
  );
}
