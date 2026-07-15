import type { ReactNode } from "react";
import type { ClientConnection } from "../../api";
import { useLocalImageUrl } from "../../hooks/useLocalImageUrl";
import type { LocalImageUrlResolver } from "../../hooks/useLocalImageUrl";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import type { WorkspaceImageUrlResolver } from "../../hooks/useWorkspaceImageUrl";
import { matchChatFilePathAt, normalizeChatFilePath } from "../../lib/chat-file-links";
import { publicAssetUrl } from "../../lib/public-assets";
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
  localImageUrls: LocalImageUrlResolver;
  workspaceImageUrls: WorkspaceImageUrlResolver;
  workspaceRootPath: string | null;
};

type ImageLink =
  | { kind: "url"; src: string; title: string }
  | { kind: "local"; path: string; src: string | null; title: string }
  | { kind: "workspace"; appId: string; path: string; src: string | null; title: string };

const PUBLIC_IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

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
        const codeContent = content.slice(index + 1, closing);
        const imagePath = context.onOpenFileInSidebar && isStandaloneInlineCodeFileLink(codeContent, content, index, closing + 1)
          ? normalizeChatFilePath(codeContent, { workspaceRootPath: context.workspaceRootPath })
          : null;
        flushText(index);
        nodes.push(imagePath
          ? renderFileLink(imagePath.displayPath, imagePath.path, imagePath.displayPath, context, nodes.length)
          : <code key={nodes.length}>{codeContent}</code>);
        index = closing + 1;
        textStart = index;
        continue;
      }
    }

    const htmlImage = char === "<" || content.startsWith("!<img", index)
      ? parseHtmlImage(content, index)
      : null;
    if (htmlImage) {
      const image = imageLinkForHref(htmlImage.src, context);
      if (image) {
        flushText(index);
        nodes.push(renderInlineImage(htmlImage.alt, image, context, nodes.length));
        index = htmlImage.end;
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

    const markdownImage = content.startsWith("![", index) ? parseMarkdownImage(content, index) : null;
    if (markdownImage) {
      const image = imageLinkForHref(markdownImage.href, context);
      flushText(index);
      nodes.push(image
        ? renderInlineImage(markdownImage.label, image, context, nodes.length)
        : renderLink(markdownImage.label || markdownImage.href, markdownImage.href, context, nodes.length));
      index = markdownImage.end;
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

    const bareLink = matchBareLinkAt(content, index);
    if (bareLink) {
      flushText(index);
      nodes.push(renderLink(bareLink.href, bareLink.href, context, nodes.length));
      index = bareLink.end;
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

function matchBareLinkAt(content: string, start: number): { href: string; end: number } | null {
  const previous = start > 0 ? content[start - 1] : "";
  if (previous && !/[\s([{<]/.test(previous)) return null;
  const slice = content.slice(start);
  const match = /^(?:https?:\/\/|www\.)[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/i.exec(slice);
  if (!match) return null;
  let href = match[0];
  while (/[.,;:!?]$/.test(href)) href = href.slice(0, -1);
  if (!href) return null;
  const normalizedHref = /^www\./i.test(href) ? `https://${href}` : href;
  return { href: normalizedHref, end: start + href.length };
}

function isStandaloneInlineCodeFileLink(codeContent: string, content: string, start: number, end: number): boolean {
  if (isResourceFileRef(codeContent)) return true;
  return !content.slice(0, start).trim() && !content.slice(end).trim();
}

function isResourceFileRef(value: string): boolean {
  return /^(?:workspace|sandbox):file:/i.test(value.trim());
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

function renderInlineImage(label: string, image: ImageLink, context: MarkdownContext, key: number): ReactNode {
  return <MarkdownInlineImage context={context} image={image} key={key} label={label} />;
}

function MarkdownInlineImage({
  context,
  image,
  label,
}: {
  context: MarkdownContext;
  image: ImageLink;
  label: string;
}) {
  const workspaceSrc = useWorkspaceImageUrl(
    context.connection,
    image.kind === "workspace" ? image.appId : null,
    image.kind === "workspace" ? image.path : null,
  );
  const localSrc = useLocalImageUrl(
    context.connection,
    image.kind === "local" ? image.path : null,
  );
  const src = image.kind === "url" ? image.src : image.kind === "local" ? localSrc : workspaceSrc;
  const title = label.trim() || image.title;

  return (
    <button
      type="button"
      className={`markdown-inline-image ${src ? "ready" : "loading"}`}
      onClick={() => {
        if (image.kind === "url") {
          context.onOpenImage({ src: image.src, title });
          return;
        }
        if (src) {
          context.onOpenImage({ src, title });
          return;
        }
        if (image.kind === "local") return;
        context.onOpenWorkspaceImage({ appId: image.appId, path: image.path, title });
      }}
      title={title}
    >
      {src ? <img alt={title} decoding="async" loading="lazy" src={src} /> : <span aria-hidden="true" />}
    </button>
  );
}

function renderFileLink(
  label: ReactNode,
  path: string,
  displayPath: string,
  context: MarkdownContext,
  key: number,
): ReactNode {
  const image = imageLinkForFilePath(path, displayPath, context);
  if (image) {
    return (
      <MarkdownFileImageReference
        context={context}
        displayPath={displayPath}
        image={image}
        key={key}
        label={label}
        path={path}
      />
    );
  }
  return <MarkdownFileLink context={context} displayPath={displayPath} label={label} path={path} key={key} />;
}

function MarkdownFileLink({
  context,
  displayPath,
  label,
  path,
}: {
  context: MarkdownContext;
  displayPath: string;
  label: ReactNode;
  path: string;
}) {
  return (
    <a
      href="#"
      className="markdown-file-link"
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

function MarkdownFileImageReference({
  context,
  displayPath,
  image,
  label,
  path,
}: {
  context: MarkdownContext;
  displayPath: string;
  image: ImageLink;
  label: ReactNode;
  path: string;
}) {
  const workspaceSrc = useWorkspaceImageUrl(
    context.connection,
    image.kind === "workspace" ? image.appId : null,
    image.kind === "workspace" ? image.path : null,
  );
  const localSrc = useLocalImageUrl(
    context.connection,
    image.kind === "local" ? image.path : null,
  );
  const src = image.kind === "url" ? image.src : image.kind === "local" ? localSrc : workspaceSrc;
  const title = image.title || displayPath;

  return (
    <span className="markdown-file-image-reference">
      <MarkdownFileLink context={context} displayPath={displayPath} label={label} path={path} />
      <button
        type="button"
        className={`markdown-file-image-preview ${src ? "ready" : "loading"}`}
        onClick={() => {
          if (image.kind === "url") {
            context.onOpenImage({ src: image.src, title });
            return;
          }
          if (src) {
            context.onOpenImage({ src, title });
            return;
          }
          if (image.kind === "local") return;
          context.onOpenWorkspaceImage({ appId: image.appId, path: image.path, title });
        }}
        title={title}
      >
        {src ? <img alt={title} decoding="async" loading="lazy" src={src} /> : <span aria-hidden="true" />}
      </button>
    </span>
  );
}

function parseMarkdownImage(content: string, start: number): { label: string; href: string; end: number } | null {
  if (!content.startsWith("![", start)) return null;
  const labelStart = start + 2;
  const labelEnd = content.indexOf("]", labelStart);
  if (labelEnd < labelStart || content[labelEnd + 1] !== "(") return null;
  const link = parseMarkdownHref(content, labelEnd + 2);
  if (!link) return null;
  return {
    label: content.slice(labelStart, labelEnd),
    href: link.href,
    end: link.end,
  };
}

function parseMarkdownLink(content: string, start: number): { label: string; href: string; end: number } | null {
  const labelEnd = content.indexOf("]", start + 1);
  if (labelEnd <= start + 1 || content[labelEnd + 1] !== "(") return null;
  const link = parseMarkdownHref(content, labelEnd + 2);
  if (!link) return null;
  return {
    label: content.slice(start + 1, labelEnd),
    href: link.href,
    end: link.end,
  };
}

function parseMarkdownHref(content: string, hrefStart: number): { href: string; end: number } | null {
  if (content[hrefStart] === "<") {
    const hrefEnd = content.indexOf(">", hrefStart + 1);
    if (hrefEnd < 0 || content[hrefEnd + 1] !== ")") return null;
    return {
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
          href: content.slice(hrefStart, index),
          end: index + 1,
        };
      }
      depth -= 1;
    }
  }
  return null;
}

function parseHtmlImage(content: string, start: number): { src: string; alt: string; end: number } | null {
  const imageStart = content[start] === "!" ? start + 1 : start;
  if (!/^<img\b/i.test(content.slice(imageStart))) return null;
  const end = content.indexOf(">", imageStart + 4);
  if (end < 0) return null;
  const tag = content.slice(imageStart, end + 1);
  const src = htmlAttributeValue(tag, "src");
  if (!src) return null;
  return {
    src,
    alt: htmlAttributeValue(tag, "alt") ?? htmlAttributeValue(tag, "title") ?? "",
    end: end + 1,
  };
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

function htmlAttributeValue(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isLinkLikeHref(value: string): boolean {
  return /^(https?:\/\/|file:\/\/|(?:workspace|sandbox):file:|\/|\.{1,2}\/)/i.test(value);
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
  const publicUrl = publicAssetImageUrlFromPath(imagePath ?? cleanHref, context.workspaceRootPath);
  if (publicUrl) {
    return { kind: "url", src: publicUrl, title: workspaceFileName(imagePath ?? cleanHref) };
  }
  if (!imagePath || !isWorkspaceImagePath(imagePath) || !context.connection) return null;
  if (isAbsoluteLocalImageHref(imagePath)) {
    return {
      kind: "local",
      path: imagePath,
      src: context.localImageUrls.getUrl(imagePath),
      title: workspaceFileName(imagePath),
    };
  }
  if (!context.activeWorkspaceAppId) return null;
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

function imageLinkForFilePath(path: string, displayPath: string, context: MarkdownContext): ImageLink | null {
  const publicUrl = publicAssetImageUrlFromPath(path, context.workspaceRootPath)
    ?? publicAssetImageUrlFromPath(displayPath, context.workspaceRootPath);
  if (publicUrl) {
    return { kind: "url", src: publicUrl, title: workspaceFileName(displayPath) };
  }

  if (!isWorkspaceImagePath(path) || !context.connection) return null;
  if (isAbsoluteLocalImageHref(path)) {
    return {
      kind: "local",
      path,
      src: context.localImageUrls.getUrl(path),
      title: workspaceFileName(path),
    };
  }
  if (!context.activeWorkspaceAppId) return null;
  const workspacePath = workspaceRelativeImagePath(path, context.workspaceRootPath);
  if (!workspacePath || !isWorkspaceImagePath(workspacePath)) return null;
  return {
    kind: "workspace",
    appId: context.activeWorkspaceAppId,
    path: workspacePath,
    src: context.workspaceImageUrls.getUrl(context.activeWorkspaceAppId, workspacePath),
    title: workspaceFileName(workspacePath),
  };
}

function publicAssetImageUrlFromPath(value: string, workspaceRootPath: string | null): string | null {
  const workspacePath = workspaceRelativeImagePath(value, workspaceRootPath);
  const publicPrefix = "apps/web/public/";
  if (!workspacePath?.startsWith(publicPrefix)) return null;
  const publicPath = workspacePath.slice(publicPrefix.length);
  if (!publicPath || !isPublicImagePath(publicPath)) return null;
  return publicAssetUrl(publicPath.split("/").map(encodeURIComponent).join("/"));
}

function isPublicImagePath(path: string): boolean {
  const cleanPath = path.split("?")[0]?.split("#")[0] ?? path;
  const dotIndex = cleanPath.lastIndexOf(".");
  if (dotIndex < 0) return false;
  return PUBLIC_IMAGE_EXTENSIONS.has(cleanPath.slice(dotIndex).toLowerCase());
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
      if (url.pathname === "/v1/assets/workspace-image" || url.pathname === "/v1/assets/chat-attachment-image") return true;
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
  const chatAttachmentName = url.pathname === "/v1/assets/chat-attachment-image" ? url.searchParams.get("storageName") : null;
  if (chatAttachmentName && isWorkspaceImagePath(chatAttachmentName)) {
    return { kind: "url", src: url.toString(), title: workspaceFileName(chatAttachmentName) };
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
  if (image.kind === "local") {
    if (image.src) context.onOpenImage({ src: image.src, title: image.title });
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
  if (image.kind === "local") {
    if (image.src) {
      context.onPreviewImage(positionImagePreview({ src: image.src, title: image.title }, element));
      return;
    }
    void context.localImageUrls.loadUrl(image.path).then((src) => {
      if (src && element.matches(":hover")) {
        context.onPreviewImage(positionImagePreview({ src, title: image.title }, element));
      }
    });
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
