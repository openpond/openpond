import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientConnection } from "../../api";
import { copyToClipboard } from "../../lib/clipboard";
import { normalizeChatFilePath } from "../../lib/chat-file-links";
import { useLocalImageUrlResolver } from "../../hooks/useLocalImageUrl";
import { useWorkspaceImageUrlResolver } from "../../hooks/useWorkspaceImageUrl";
import { ImageLightbox } from "../common/ImageLightbox";
import { parseBlocks } from "./MarkdownBlocks";
import {
  MarkdownCheckbox,
  renderInline,
  type ImageLinkPreview,
  type LinkContextMenu,
  type MarkdownContext,
  type OpenBrowserLink,
  type OpenFileLink,
} from "./MarkdownInline";
import { revealLocalFile } from "../../lib/desktop-files";

export function MarkdownText({
  activeWorkspaceAppId = null,
  connection = null,
  content,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  workspaceRootPath = null,
}: {
  activeWorkspaceAppId?: string | null;
  connection?: ClientConnection | null;
  content: string;
  onOpenBrowserLink?: OpenBrowserLink;
  onOpenFileInSidebar?: OpenFileLink;
  workspaceRootPath?: string | null;
}) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const [openImage, setOpenImage] = useState<{ src: string; title: string } | null>(null);
  const [hoverImage, setHoverImage] = useState<ImageLinkPreview | null>(null);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenu | null>(null);
  const localImageUrls = useLocalImageUrlResolver(connection);
  const workspaceImageUrls = useWorkspaceImageUrlResolver(connection);
  const handleOpenWorkspaceImage = useCallback(
    (image: { appId: string; path: string; title: string }) => {
      void workspaceImageUrls.loadUrl(image.appId, image.path).then((src) => {
        if (src) setOpenImage({ src, title: image.title });
      });
    },
    [workspaceImageUrls],
  );
  const context = useMemo<MarkdownContext>(
    () => ({
      activeWorkspaceAppId,
      connection,
      onOpenBrowserLink,
      onOpenFileInSidebar,
      onOpenLinkMenu: setLinkMenu,
      onOpenImage: setOpenImage,
      onOpenWorkspaceImage: handleOpenWorkspaceImage,
      onPreviewImage: setHoverImage,
      localImageUrls,
      workspaceImageUrls,
      workspaceRootPath,
    }),
    [
      activeWorkspaceAppId,
      connection,
      handleOpenWorkspaceImage,
      localImageUrls,
      onOpenBrowserLink,
      onOpenFileInSidebar,
      workspaceImageUrls,
      workspaceRootPath,
    ],
  );

  useEffect(() => {
    if (!linkMenu) return undefined;
    const close = () => setLinkMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [linkMenu]);

  return (
    <div className="markdown-message">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          const fileReferenceLines = fileReferenceCodeBlockLines(block.content, workspaceRootPath);
          if (fileReferenceLines) {
            return (
              <div className="markdown-file-reference-block" key={index}>
                {fileReferenceLines.map((line, lineIndex) => (
                  <div className="markdown-file-reference-line" key={lineIndex}>
                    {renderInline(line, context)}
                  </div>
                ))}
              </div>
            );
          }
          return (
            <pre className="markdown-code-block" key={index}>
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag className="markdown-list" key={index}>
              {block.items.map((item, itemIndex) => (
                <li className={item.checked === null ? undefined : "markdown-task-list-item"} key={itemIndex}>
                  {item.checked === null ? null : <MarkdownCheckbox checked={item.checked} />}
                  <span>{renderInline(item.content, context)}</span>
                </li>
              ))}
            </ListTag>
          );
        }
        if (block.type === "heading") {
          const HeadingTag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : block.level === 3 ? "h3" : "h4";
          return (
            <HeadingTag className="markdown-heading" key={index}>
              {renderInline(block.content, context)}
            </HeadingTag>
          );
        }
        if (block.type === "table") {
          return (
            <div className="markdown-table-wrap" key={index}>
              <table className="markdown-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex}>{renderInline(header, context)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={cellIndex}>{renderInline(row[cellIndex] ?? "", context)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p className="markdown-paragraph" key={index}>
            {renderInline(block.content, context)}
          </p>
        );
      })}
      {hoverImage && (
        <MarkdownImageHoverPreview preview={hoverImage} />
      )}
      {linkMenu && (
        <MarkdownLinkMenu
          menu={linkMenu}
          onClose={() => setLinkMenu(null)}
          onOpenBrowserLink={onOpenBrowserLink}
          onOpenFileInSidebar={onOpenFileInSidebar}
        />
      )}
      <ImageLightbox
        open={Boolean(openImage)}
        src={openImage?.src ?? null}
        title={openImage?.title ?? ""}
        onClose={() => setOpenImage(null)}
      />
    </div>
  );
}

function fileReferenceCodeBlockLines(content: string, workspaceRootPath: string | null): string[] | null {
  const lines = content.split("\n");
  const normalizedLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const withoutBullet = trimmed.replace(/^(?:[-*]|\d+[.)])\s+/, "").trim();
    const candidate = withoutBullet.replace(/^`+|`+$/g, "").trim();
    if (!candidate || !normalizeChatFilePath(candidate, { workspaceRootPath })) return null;
    normalizedLines.push(candidate);
  }
  return normalizedLines.length > 0 ? normalizedLines : null;
}

function MarkdownImageHoverPreview({ preview }: { preview: ImageLinkPreview }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [preview.src]);

  return (
    <div
      className={`markdown-image-hover-preview ${failed ? "unavailable" : ""}`}
      style={{ left: preview.x, top: preview.y }}
    >
      {failed ? (
        <span>Preview unavailable</span>
      ) : (
        <img alt="" src={preview.src} onError={() => setFailed(true)} />
      )}
      <span>{preview.title}</span>
    </div>
  );
}

function MarkdownLinkMenu({
  menu,
  onClose,
  onOpenBrowserLink,
  onOpenFileInSidebar,
}: {
  menu: LinkContextMenu;
  onClose: () => void;
  onOpenBrowserLink?: OpenBrowserLink;
  onOpenFileInSidebar?: OpenFileLink;
}) {
  if (menu.kind === "file") {
    return (
      <div
        className="markdown-link-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onOpenFileInSidebar?.(menu.path);
            onClose();
          }}
        >
          Open in sidebar
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            void revealLocalFile(menu.path);
            onClose();
          }}
        >
          Open externally
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            void copyToClipboard(menu.displayPath);
            onClose();
          }}
        >
          Copy path
        </button>
      </div>
    );
  }

  return (
    <div
      className="markdown-link-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          if (onOpenBrowserLink) onOpenBrowserLink(menu.browserHref);
          else window.open(menu.browserHref, "_blank", "noopener,noreferrer");
          onClose();
        }}
      >
        Open in sidebar
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          if (onOpenBrowserLink) onOpenBrowserLink(menu.browserHref, { newTab: true });
          else window.open(menu.browserHref, "_blank", "noopener,noreferrer");
          onClose();
        }}
      >
        Open in new tab
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          window.open(menu.browserHref, "_blank", "noopener,noreferrer");
          onClose();
        }}
      >
        Open externally
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void copyToClipboard(menu.displayHref);
          onClose();
        }}
      >
        Copy link
      </button>
    </div>
  );
}
