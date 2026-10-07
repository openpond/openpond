import { useCallback } from "react";
import { api, type ClientConnection } from "../api";
import { normalizeChatFilePath } from "../lib/chat-file-links";
import { absoluteLocalVideoPath } from "../lib/local-video";
import { revealLocalFile } from "../lib/desktop-files";
import { htmlPreviewUrl, isHtmlFilePath } from "../lib/html-preview";
import type { ShowAppToast } from "../app/app-state";
import type { WorkspaceDiffOpenFileRequest } from "../components/workspace-diff/workspace-diff-panel-model";

export function useChatFileOpen({
  connection,
  handleOpenBrowserLink,
  activeWorkspaceAppId,
  rightSidebarUsesSandbox,
  rightSidebarSandboxId,
  onShowDiffPanel,
  showToast,
  workspaceRootPath,
  setOpenDiffFileRequest,
}: {
  connection: ClientConnection | null;
  handleOpenBrowserLink: (url: string) => void;
  activeWorkspaceAppId: string | null;
  rightSidebarUsesSandbox: boolean;
  rightSidebarSandboxId: string | null;
  onShowDiffPanel: () => void;
  showToast: ShowAppToast;
  workspaceRootPath: string | null;
  setOpenDiffFileRequest: (request: WorkspaceDiffOpenFileRequest) => void;
}) {
  return useCallback(
    (path: string, options?: { source?: boolean }) => {
      if (/[\\/]$/.test(path)) {
        const target = /^(?:[~/\\]|[A-Za-z]:)/.test(path) ? path : workspaceRootPath ? `${workspaceRootPath}/${path}` : path;
        void revealLocalFile(target).then((opened) => {
          if (!opened) showToast("Open this folder in the desktop app on the machine where it was created.", "error");
        });
        return;
      }
      const htmlWorkspaceId = rightSidebarUsesSandbox ? rightSidebarSandboxId : activeWorkspaceAppId;
      if (isHtmlFilePath(path) && !options?.source && connection && htmlWorkspaceId) {
        void htmlPreviewUrl(connection, htmlWorkspaceId, path, rightSidebarUsesSandbox ? "sandbox" : "local")
          .then((url) => handleOpenBrowserLink(url))
          .catch((error) => showToast(error instanceof Error ? error.message : "Could not open HTML preview.", "error"));
        return;
      }
      const videoPath = absoluteLocalVideoPath(path, workspaceRootPath);
      if (videoPath && connection) {
        void api
          .signLocalVideoUrl(connection, { path: videoPath })
          .then(({ url }) => handleOpenBrowserLink(url))
          .catch((error) => {
            showToast(
              error instanceof Error
                ? error.message
                : "Could not open this video.",
              "error"
            );
          });
        return;
      }
      const normalizedFile = normalizeChatFilePath(path, { workspaceRootPath });
      onShowDiffPanel();
      setOpenDiffFileRequest({
        id: Date.now(),
        path: options?.source && isHtmlFilePath(path) ? (normalizedFile?.path ?? path).replace(/[?#].*$/, "") : normalizedFile?.path ?? path,
        source: options?.source,
      });
    },
    [
      connection,
      handleOpenBrowserLink,
      activeWorkspaceAppId,
      rightSidebarUsesSandbox,
      rightSidebarSandboxId,
      onShowDiffPanel,
      showToast,
      workspaceRootPath,
      setOpenDiffFileRequest,
    ]
  );
}
