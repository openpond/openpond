import type { ReactNode } from "react";
import type { ClientConnection } from "../../api";
import type { WorkspaceImageUrlResolver } from "../../hooks/useWorkspaceImageUrl";
import { matchChatFilePathAt, normalizeChatFilePath } from "../../lib/chat-file-links";
import { isWorkspaceImagePath, workspaceFileName } from "../../lib/workspace-images";

export type ImageLinkPreview = {
  src: string;
  title: string;
  x: number;
  y: number;
};

export type LinkContextMenu =
  | { kind: "browser"; browserHref: string; displayHref: string; x: number; y: number }
  | { kind: "file"; displayPath: string; path: string; x: number; y: number };

export type OpenBrowserLink = (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
export type OpenFileLink = (path: string) => void;

export type MarkdownContext = {
  activeWorkspaceAppId: string | null;
  connection: ClientConnection | null;
  onOpenBrowserLink?: OpenBrowserLink;
  onOpenFileInSidebar?: OpenFileLink;
  onOpenWorkspaceImage: (image: { appId: string; path: string; title: string }) => void;
  onOpenLinkMenu: (menu: LinkContextMenu | null) => void;
  onOpenImage: (image: { src: string; title: string }) => void;
  onPreviewImage: (image: ImageLinkPreview | null) => void;
  workspaceImageUrls: WorkspaceImageUrlResolver;
  workspaceRootPath: string | null;
};

type ImageLink =
  | { kind: "url"; src: string; title: string }
  | { kind: "workspace"; appId: string; path: string; src: string | null; title: string };

export function MarkdownCheckbox({
  checked,
  inline = false,
}: {
  checked: boolean;
  inline?: boolean;
}) {
  return (
    <input
      aria-label={checked ? "Checked item" : "Unchecked item"}
      checked={checked}
      className={`markdown-checkbox ${inline ? "inline" : ""}`}
      disabled
      readOnly
      type="checkbox"
    />
  );
}

export function renderInline(content: string, context: MarkdownContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) nodes.push(content.slice(textStart, end));
  };

  while (index < content.length) {
    const char = content[index];
    if (char === "`") {
      const closing = content.indexOf("`", index + 1);
      if (closing > index + 1) {
        flushText(index);
        nodes.push(<code key={nodes.length}>{content.slice(index + 1, closing)}</code>);
        index = closing + 1;
        textStart = index;
        continue;
      }
    }

    const htmlAnchor = char === "<" ? parseHtmlAnchor(content, index) : null;
    if (htmlAnchor) {
      flushText(index);
      nodes.push(renderLink(htmlAnchor.label, htmlAnchor.href, context, nodes.length));
      index = htmlAnchor.end;
      textStart = index;
      continue;
    }

    const angleLink = char === "<" ? parseAngleLink(content, index) : null;
    if (angleLink) {
      flushText(index);
      nodes.push(renderLink(angleLink.href, angleLink.href, context, nodes.length));
      index = angleLink.end;
      textStart = index;
      continue;
    }

    const checkbox = char === "[" ? parseCheckboxToken(content, index) : null;
    if (checkbox) {
      flushText(index);
      nodes.push(<MarkdownCheckbox checked={checkbox.checked} inline key={nodes.length} />);
      index = checkbox.end;
      textStart = index;
      continue;
    }

    const markdownLink = char === "[" ? parseMarkdownLink(content, index) : null;
    if (markdownLink) {
      flushText(index);
      nodes.push(renderLink(markdownLink.label, markdownLink.href, context, nodes.length));
      index = markdownLink.end;
      textStart = index;
      continue;
    }

    const filePath = context.onOpenFileInSidebar
      ? matchChatFilePathAt(content, index, { workspaceRootPath: context.workspaceRootPath })
      : null;
    if (filePath) {
      flushText(index);
      nodes.push(renderFileLink(filePath.displayPath, filePath.path, filePath.displayPath, context, nodes.length));
      index = filePath.end;
      textStart = index;
      continue;
    }

    if (content.startsWith("**", index)) {
      const closing = content.indexOf("**", index + 2);
      if (closing > index + 2) {
        flushText(index);
        nodes.push(<strong key={nodes.length}>{content.slice(index + 2, closing)}</strong>);
        index = closing + 2;
        textStart = index;
        continue;
      }
    }

    if (content.startsWith("__", index)) {
      const closing = content.indexOf("__", index + 2);
      if (closing > index + 2) {
        flushText(index);
        nodes.push(<strong key={nodes.length}>{content.slice(index + 2, closing)}</strong>);
        index = closing + 2;
        textStart = index;
        continue;
      }
    }

    index += 1;
  }

  flushText(content.length);
  return nodes;
}

function renderLink(label: string, href: string, context: MarkdownContext, key: number): ReactNode {
  const cleanHref = cleanLinkHref(href);
  const image = imageLinkForHref(cleanHref, context);
  const external = /^https?:\/\//i.test(cleanHref);
  const browserHref = image?.kind === "url" ? image.src : image?.src ?? cleanHref;
  const filePath = context.onOpenFileInSidebar
    ? normalizeChatFilePath(cleanHref, { workspaceRootPath: context.workspaceRootPath })
    : null;
  if (!image && filePath) {
    return renderFileLink(label, filePath.path, filePath.displayPath, context, key);
  }
  return (
    <a
      href={external || image ? browserHref : "#"}
      className={image ? "markdown-image-link" : undefined}
      key={key}
      onBlur={() => {
        if (image) context.onPreviewImage(null);
      }}
      onClick={(event) => {
        if (image) {
          event.preventDefault();
          openImageLink(image, context);
          context.onPreviewImage(null);
          return;
        }
        if (external && context.onOpenBrowserLink) {
          event.preventDefault();
          context.onOpenBrowserLink(browserHref);
          return;
        }
        if (!external) event.preventDefault();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        context.onPreviewImage(null);
        context.onOpenLinkMenu(positionLinkMenu(browserHref, cleanHref, event.clientX, event.clientY));
      }}
      onFocus={(event) => {
        if (image) previewImageLink(image, context, event.currentTarget);
      }}
      onMouseEnter={(event) => {
        if (image) previewImageLink(image, context, event.currentTarget);
      }}
      onMouseLeave={() => {
        if (image) context.onPreviewImage(null);
      }}
      rel={external ? "noreferrer" : undefined}
      target={external ? "_blank" : undefined}
      title={cleanHref}
    >
      {label}
    </a>
  );
}

function renderFileLink(
  label: string,
  path: string,
  displayPath: string,
  context: MarkdownContext,
  key: number,
): ReactNode {
  return (
    <a
      href="#"
      className="markdown-file-link"
      key={key}
      onClick={(event) => {
        event.preventDefault();
        context.onOpenFileInSidebar?.(path);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        context.onPreviewImage(null);
        context.onOpenLinkMenu(positionFileMenu(path, displayPath, event.clientX, event.clientY));
      }}
      title={displayPath}
    >
      {label}
    </a>
  );
}

function parseMarkdownLink(content: string, start: number): { label: string; href: string; end: number } | null {
  const labelEnd = content.indexOf("]", start + 1);
  if (labelEnd <= start + 1 || content[labelEnd + 1] !== "(") return null;
  const hrefStart = labelEnd + 2;
  if (content[hrefStart] === "<") {
    const hrefEnd = content.indexOf(">", hrefStart + 1);
    if (hrefEnd < 0 || content[hrefEnd + 1] !== ")") return null;
    return {
      label: content.slice(start + 1, labelEnd),
      href: content.slice(hrefStart + 1, hrefEnd),
      end: hrefEnd + 2,
    };
  }
  let depth = 0;
  for (let index = hrefStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        return {
          label: content.slice(start + 1, labelEnd),
          href: content.slice(hrefStart, index),
          end: index + 1,
        };
      }
      depth -= 1;
    }
  }
  return null;
}

function parseCheckboxToken(content: string, start: number): { checked: boolean; end: number } | null {
  const token = content.slice(start, start + 3);
  if (token === "[ ]") return { checked: false, end: start + 3 };
  if (token === "[x]" || token === "[X]") return { checked: true, end: start + 3 };
  return null;
}

function parseHtmlAnchor(content: string, start: number): { label: string; href: string; end: number } | null {
  const slice = content.slice(start);
  const match = /^<a\s+[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>(.*?)<\/a>/i.exec(slice);
  if (!match) return null;
  return {
    href: match[2] ?? "",
    label: stripInlineHtml(match[3] ?? ""),
    end: start + match[0].length,
  };
}

function parseAngleLink(content: string, start: number): { href: string; end: number } | null {
  const end = content.indexOf(">", start + 1);
  if (end <= start + 1) return null;
  const href = content.slice(start + 1, end).trim();
  if (!isLinkLikeHref(href)) return null;
  return { href, end: end + 1 };
}

function stripInlineHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim() || value;
}

function isLinkLikeHref(value: string): boolean {
  return /^(https?:\/\/|file:\/\/|\/|\.{1,2}\/)/i.test(value);
}

function imageLinkForHref(
  href: string,
  context: MarkdownContext,
): ImageLink | null {
  const cleanHref = cleanLinkHref(href);
  if (!cleanHref) return null;
  if (/^https?:\/\//i.test(cleanHref)) {
    try {
      const url = new URL(cleanHref);
      const workspaceTarget = workspaceImageTargetFromServerUrl(url, context);
      if (workspaceTarget) return workspaceTarget;
      if (!isImageHttpUrl(url, context.connection)) return null;
      return { kind: "url", src: cleanHref, title: workspaceFileName(url.searchParams.get("path") ?? url.pathname) };
    } catch {
      return null;
    }
  }
  const imagePath = localImagePathFromHref(cleanHref);
  if (!imagePath || !isWorkspaceImagePath(imagePath) || !context.connection || !context.activeWorkspaceAppId) return null;
  const workspacePath = workspaceRelativeImagePath(imagePath, context.workspaceRootPath);
  if (!workspacePath || !isWorkspaceImagePath(workspacePath)) return null;
  return {
    kind: "workspace",
    appId: context.activeWorkspaceAppId,
    path: workspacePath,
    src: context.workspaceImageUrls.getUrl(context.activeWorkspaceAppId, workspacePath),
    title: workspaceFileName(workspacePath),
  };
}

function cleanLinkHref(href: string): string {
  return href.trim().replace(/^['"`]+|['"`]+$/g, "");
}

function localImagePathFromHref(href: string): string | null {
  let cleaned = href.trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return cleaned.replace(/^file:\/\//, "");
    }
  }
  if (isAbsoluteLocalImageHref(cleaned)) return cleaned;
  const hashIndex = cleaned.indexOf("#");
  if (hashIndex >= 0) cleaned = cleaned.slice(0, hashIndex);
  const queryIndex = cleaned.indexOf("?");
  if (queryIndex >= 0) cleaned = cleaned.slice(0, queryIndex);
  return cleaned;
}

function isAbsoluteLocalImageHref(value: string): boolean {
  return /^file:\/\//i.test(value) || /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function workspaceRelativeImagePath(value: string, workspaceRootPath: string | null): string | null {
  let cleaned = value.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      cleaned = cleaned.replace(/^file:\/\//, "");
    }
  }
  cleaned = cleaned.replace(/\\/g, "/");
  if (isAbsoluteLocalImageHref(cleaned)) {
    const root = workspaceRootPath?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root || !cleaned.startsWith(`${root}/`)) return null;
    cleaned = cleaned.slice(root.length + 1);
  }
  cleaned = cleaned.replace(/^\.\/+/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === ".." || part === ".git")) return null;
  return parts.join("/");
}

function isImageHttpUrl(url: URL, connection: ClientConnection | null): boolean {
  if (connection) {
    const serverUrl = new URL(connection.serverUrl);
    if (url.origin === serverUrl.origin) {
      if (url.pathname === "/v1/local-image" || /\/v1\/workspaces\/[^/]+\/file-image$/.test(url.pathname)) return false;
      if (url.pathname === "/v1/assets/workspace-image") return true;
    }
  }
  if (isWorkspaceImagePath(url.pathname)) return true;
  const pathParam = url.searchParams.get("path");
  return Boolean(pathParam && isWorkspaceImagePath(pathParam));
}

function workspaceImageTargetFromServerUrl(url: URL, context: MarkdownContext): ImageLink | null {
  if (!context.connection) return null;
  const serverUrl = new URL(context.connection.serverUrl);
  if (url.origin !== serverUrl.origin) return null;
  const signedPath = url.pathname === "/v1/assets/workspace-image" ? url.searchParams.get("path") : null;
  if (signedPath && isWorkspaceImagePath(signedPath)) {
    return { kind: "url", src: url.toString(), title: workspaceFileName(signedPath) };
  }
  const workspaceMatch = /^\/v1\/workspaces\/([^/]+)\/file-image$/.exec(url.pathname);
  const legacyPath = workspaceMatch ? url.searchParams.get("path") : null;
  if (!workspaceMatch || !legacyPath || !isWorkspaceImagePath(legacyPath)) return null;
  const appId = decodeURIComponent(workspaceMatch[1]!);
  const path = workspaceRelativeImagePath(legacyPath, context.workspaceRootPath);
  if (!path || !isWorkspaceImagePath(path)) return null;
  return {
    kind: "workspace",
    appId,
    path,
    src: context.workspaceImageUrls.getUrl(appId, path),
    title: workspaceFileName(path),
  };
}

function openImageLink(image: ImageLink, context: MarkdownContext): void {
  if (image.kind === "url") {
    context.onOpenImage(image);
    return;
  }
  if (image.src) {
    context.onOpenImage({ src: image.src, title: image.title });
    return;
  }
  context.onOpenWorkspaceImage({ appId: image.appId, path: image.path, title: image.title });
}

function previewImageLink(image: ImageLink, context: MarkdownContext, element: HTMLElement): void {
  if (image.kind === "url") {
    context.onPreviewImage(positionImagePreview(image, element));
    return;
  }
  if (image.src) {
    context.onPreviewImage(positionImagePreview({ src: image.src, title: image.title }, element));
    return;
  }
  void context.workspaceImageUrls.loadUrl(image.appId, image.path).then((src) => {
    if (src && element.matches(":hover")) {
      context.onPreviewImage(positionImagePreview({ src, title: image.title }, element));
    }
  });
}

function positionImagePreview(image: { src: string; title: string }, element: HTMLElement): ImageLinkPreview {
  const rect = element.getBoundingClientRect();
  const width = 236;
  const height = 172;
  const margin = 12;
  const x = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const below = rect.bottom + 8;
  const y = below + height <= window.innerHeight - margin ? below : Math.max(margin, rect.top - height - 8);
  return { ...image, x, y };
}

function positionLinkMenu(browserHref: string, displayHref: string, clientX: number, clientY: number): LinkContextMenu {
  const width = 220;
  const height = 142;
  const margin = 8;
  return {
    kind: "browser",
    browserHref,
    displayHref,
    x: Math.max(margin, Math.min(clientX, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(clientY, window.innerHeight - height - margin)),
  };
}

function positionFileMenu(path: string, displayPath: string, clientX: number, clientY: number): LinkContextMenu {
  const width = 220;
  const height = 72;
  const margin = 8;
  return {
    kind: "file",
    path,
    displayPath,
    x: Math.max(margin, Math.min(clientX, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(clientY, window.innerHeight - height - margin)),
  };
}
