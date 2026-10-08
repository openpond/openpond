import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ClientConnection } from "../api";
import { normalizeChatFilePath } from "../lib/chat-file-links";
import { absoluteLocalVideoPath } from "../lib/local-video";
import { revealLocalFile } from "../lib/desktop-files";
import { htmlPreviewUrl, isHtmlFilePath } from "../lib/html-preview";
import type { ShowAppToast } from "../app/app-state";
import type { WorkspaceDiffOpenFileRequest } from "../components/workspace-diff/workspace-diff-panel-model";

export function useChatFileOpen({
  conversationKey,
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
  conversationKey: string | null;
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
  const [fileResolution, setFileResolution] = useState<{
    requestedPath: string; candidates: string[]; truncated: boolean; source?: boolean;
  } | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => {
    requestVersion.current++;
    setFileResolution(null);
    return () => { requestVersion.current++; };
  }, [connection, activeWorkspaceAppId, conversationKey, rightSidebarSandboxId]);
  const openResolvedFile = useCallback(
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
  const handleOpenFileInSidebar = useCallback((requestedPath: string, options?: { source?: boolean }) => {
    const version = ++requestVersion.current;
    setFileResolution(null);
    if (/^https?:\/\//i.test(requestedPath)) { handleOpenBrowserLink(requestedPath); return; }
    if (!connection || !activeWorkspaceAppId || rightSidebarUsesSandbox) {
      openResolvedFile(requestedPath, options);
      return;
    }
    const normalized = normalizeChatFilePath(requestedPath)?.path ?? requestedPath;
    const htmlSuffix = isHtmlFilePath(normalized) ? normalized.match(/[?#].*$/)?.[0] ?? "" : "";
    const lookupPath = htmlSuffix ? normalized.slice(0, -htmlSuffix.length) : normalized;
    void api.resolveWorkspaceFile(connection, activeWorkspaceAppId, lookupPath).then(result => {
      if (version !== requestVersion.current) return;
      if (result.status === "resolved") {
        openResolvedFile(result.kind === "directory" ? `${result.path}/` : `${result.path}${htmlSuffix}`, options);
      } else if (result.candidates.length) {
        setFileResolution({ requestedPath, candidates: result.candidates.map(path => `${path}${htmlSuffix}`), truncated: result.truncated, source: options?.source });
      } else {
        showToast(result.truncated
          ? "The project search reached its limit. Open this file using its full path."
          : `Could not find ${requestedPath} in this project's folders. Try its full path.`, "error");
      }
    }).catch(error => {
      if (version === requestVersion.current) showToast(error instanceof Error ? error.message : "Could not locate this file.", "error");
    });
  }, [connection, activeWorkspaceAppId, rightSidebarUsesSandbox, openResolvedFile, handleOpenBrowserLink, showToast]);
  const dismissFileResolution = useCallback(() => setFileResolution(null), []);
  const selectFileResolution = useCallback((path: string) => {
    const source = fileResolution?.source;
    setFileResolution(null);
    handleOpenFileInSidebar(path, { source });
  }, [fileResolution, handleOpenFileInSidebar]);
  return { handleOpenFileInSidebar, fileResolution, dismissFileResolution, selectFileResolution };

}
