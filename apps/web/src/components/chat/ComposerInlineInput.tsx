import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import {
  detectConnectedAppMentionRanges,
  type ConnectedAppMentionOption,
  type ConnectedAppMentionRange,
} from "../../lib/connected-app-mentions";
import { detectComposerRepoLinks, type ComposerRepoLink } from "../../lib/composer-repo-links";
import { connectedAppIconUrl, OPENPOND_ICON_URL } from "../../lib/public-assets";
import { resizeComposerTextarea } from "./ComposerLayout";

const INLINE_TOKEN_SELECTOR = "[data-inline-token='true']";
const INLINE_REPO_LINK_SELECTOR = "[data-inline-repo-link='true']";
const INLINE_CONNECTED_APP_MENTION_SELECTOR = "[data-inline-connected-app-mention='true']";

export type ComposerInlineToken = {
  icon: "bot" | "plus" | "workflow";
  key: string;
  label: string;
  onRemove: () => void;
  position: number;
};

export type ComposerInlineInputHandle = {
  element: HTMLDivElement | null;
  focusAtPromptIndex: (index: number, options?: { afterToken?: boolean }) => void;
  resize: () => void;
};

type ExtractedEditorState = {
  text: string;
  tokenPosition: number | null;
};

function isInlineToken(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(INLINE_TOKEN_SELECTOR);
}

function isInlineRepoLink(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(INLINE_REPO_LINK_SELECTOR);
}

function isInlineConnectedAppMention(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(INLINE_CONNECTED_APP_MENTION_SELECTOR);
}

function clampIndex(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function tokenPosition(token: ComposerInlineToken | null, prompt: string): number | null {
  return token ? clampIndex(token.position, prompt.length) : null;
}

function viewIndexFromPromptIndex(
  promptIndex: number,
  token: ComposerInlineToken | null,
  prompt: string,
  afterToken = false,
): number {
  const position = tokenPosition(token, prompt);
  const index = clampIndex(promptIndex, prompt.length);
  if (position === null) return index;
  if (index > position || (afterToken && index === position)) return index + 1;
  return index;
}

function promptIndexFromViewIndex(viewIndex: number, token: ComposerInlineToken | null, prompt: string): number {
  const position = tokenPosition(token, prompt);
  if (position === null) return clampIndex(viewIndex, prompt.length);
  return clampIndex(viewIndex > position ? viewIndex - 1 : viewIndex, prompt.length);
}

function extractEditorState(root: HTMLElement): ExtractedEditorState {
  let text = "";
  let tokenAt: number | null = null;

  function visit(node: Node) {
    if (isInlineRepoLink(node)) {
      text += node.dataset.repoUrl ?? "";
      return;
    }
    if (isInlineConnectedAppMention(node)) {
      text += node.dataset.connectedMentionText ?? "";
      return;
    }
    if (isInlineToken(node)) {
      tokenAt = text.length;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node instanceof HTMLBRElement) return;
    node.childNodes.forEach(visit);
  }

  root.childNodes.forEach(visit);
  return { text, tokenPosition: tokenAt };
}

function viewLength(node: Node): number {
  if (isInlineRepoLink(node)) return node.dataset.repoUrl?.length ?? 0;
  if (isInlineConnectedAppMention(node)) return node.dataset.connectedMentionText?.length ?? 0;
  if (isInlineToken(node)) return 1;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node instanceof HTMLBRElement) return 0;
  let length = 0;
  node.childNodes.forEach((child) => {
    length += viewLength(child);
  });
  return length;
}

function selectionViewIndex(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return viewLength(root);
  const focusNode = selection.focusNode;
  const focusOffset = selection.focusOffset;
  if (!focusNode || !root.contains(focusNode)) return viewLength(root);

  let index = 0;
  let found = false;

  function visit(node: Node) {
    if (found) return;
    if (
      (isInlineToken(node) || isInlineRepoLink(node) || isInlineConnectedAppMention(node)) &&
      node.contains(focusNode)
    ) {
      if (node !== focusNode || focusOffset > 0) index += viewLength(node);
      found = true;
      return;
    }
    if (isInlineToken(node) || isInlineRepoLink(node) || isInlineConnectedAppMention(node)) {
      index += viewLength(node);
      return;
    }
    if (node === focusNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        index += focusOffset;
      } else {
        const children = Array.from(node.childNodes).slice(0, focusOffset);
        for (const child of children) index += viewLength(child);
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      index += node.textContent?.length ?? 0;
      return;
    }
    if (node instanceof HTMLBRElement) return;
    node.childNodes.forEach(visit);
  }

  visit(root);
  return index;
}

function setSelectionByViewIndex(root: HTMLElement, viewIndex: number) {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  let remaining = Math.max(0, viewIndex);

  function placeBefore(node: Node) {
    range.setStartBefore(node);
    range.collapse(true);
  }

  function placeAfter(node: Node) {
    range.setStartAfter(node);
    range.collapse(true);
  }

  function visit(node: Node): boolean {
    if (isInlineToken(node) || isInlineRepoLink(node) || isInlineConnectedAppMention(node)) {
      const length = viewLength(node);
      if (remaining <= 0) {
        placeBefore(node);
        return true;
      }
      if (remaining <= length) {
        placeAfter(node);
        return true;
      }
      remaining -= length;
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        range.collapse(true);
        return true;
      }
      remaining -= length;
      return false;
    }

    if (node instanceof HTMLBRElement) return false;

    for (const child of node.childNodes) {
      if (visit(child)) return true;
    }
    return false;
  }

  if (!visit(root)) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainText(text: string) {
  document.execCommand("insertText", false, text);
}

function iconSvg(icon: ComposerInlineToken["icon"]): string {
  if (icon === "plus") {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>';
  }
  if (icon === "bot") {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="8" x="3" y="3" rx="2"></rect><path d="M7 11v4a2 2 0 0 0 2 2h4"></path><rect width="8" height="8" x="13" y="13" rx="2"></rect></svg>';
}

function clearSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="composer-invocation-clear" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
}

function createTokenElement(token: ComposerInlineToken): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "composer-invocation-pill";
  pill.contentEditable = "false";
  pill.dataset.inlineToken = "true";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "composer-invocation-remove";
  remove.setAttribute("aria-label", `Remove ${token.label}`);
  remove.addEventListener("mousedown", (event) => event.preventDefault());
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    token.onRemove();
  });

  const icon = document.createElement("span");
  icon.className = "composer-invocation-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconSvg(token.icon);

  remove.append(icon);
  remove.insertAdjacentHTML("beforeend", clearSvg());

  const label = document.createElement("span");
  label.className = "composer-invocation-label";
  label.textContent = token.label;

  pill.append(remove, label);
  return pill;
}

function repoLinkIconSrc(link: ComposerRepoLink): string {
  return link.provider === "github" ? connectedAppIconUrl("github") : OPENPOND_ICON_URL;
}

function createRepoLinkElement(link: ComposerRepoLink): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `composer-repo-link ${link.provider}`;
  chip.contentEditable = "false";
  chip.dataset.inlineRepoLink = "true";
  chip.dataset.repoUrl = link.url;
  chip.dataset.repoProvider = link.provider;
  chip.setAttribute(
    "aria-label",
    `${link.provider === "github" ? "GitHub" : "OpenPond"} repository ${link.label}`,
  );
  chip.title = link.url;

  const icon = document.createElement("img");
  icon.className = "composer-repo-link-icon";
  icon.src = repoLinkIconSrc(link);
  icon.alt = "";
  icon.draggable = false;

  const label = document.createElement("span");
  label.className = "composer-repo-link-label";
  label.textContent = link.label;

  chip.append(icon, label);
  return chip;
}

function connectedAppIconSrc(provider: ConnectedAppMentionRange["provider"]): string {
  return connectedAppIconUrl(provider);
}

function createConnectedAppMentionElement(mention: ConnectedAppMentionRange): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `composer-connected-app-mention ${mention.provider}`;
  chip.contentEditable = "false";
  chip.dataset.inlineConnectedAppMention = "true";
  chip.dataset.connectedMentionText = mention.text;
  chip.dataset.connectedMentionProvider = mention.provider;
  chip.setAttribute("aria-label", `${mention.label} connected app mention ${mention.displayText}`);
  chip.title = mention.detail;

  const icon = document.createElement("img");
  icon.className = "composer-connected-app-mention-icon";
  icon.src = connectedAppIconSrc(mention.provider);
  icon.alt = "";
  icon.draggable = false;

  const label = document.createElement("span");
  label.className = "composer-connected-app-mention-label";
  label.textContent = mention.displayText;

  chip.append(icon, label);
  return chip;
}

function repoLinksForPrompt(prompt: string, invocationTokenPosition: number | null): ComposerRepoLink[] {
  const links = detectComposerRepoLinks(prompt);
  if (invocationTokenPosition === null) return links;
  return links.filter((link) => invocationTokenPosition <= link.start || invocationTokenPosition >= link.end);
}

function connectedAppMentionsForPrompt(
  prompt: string,
  options: ConnectedAppMentionOption[],
  invocationTokenPosition: number | null,
): ConnectedAppMentionRange[] {
  const mentions = detectConnectedAppMentionRanges(prompt, options);
  if (invocationTokenPosition === null) return mentions;
  return mentions.filter((mention) => invocationTokenPosition <= mention.start || invocationTokenPosition >= mention.end);
}

type ComposerInlineVisualRange =
  | { end: number; kind: "repo"; link: ComposerRepoLink; start: number }
  | { end: number; kind: "connected-app"; mention: ConnectedAppMentionRange; start: number };

function inlineVisualRanges(
  prompt: string,
  invocationTokenPosition: number | null,
  connectedAppMentions: ConnectedAppMentionOption[],
): ComposerInlineVisualRange[] {
  const candidates: ComposerInlineVisualRange[] = [
    ...repoLinksForPrompt(prompt, invocationTokenPosition).map((link) => ({
      end: link.end,
      kind: "repo" as const,
      link,
      start: link.start,
    })),
    ...connectedAppMentionsForPrompt(prompt, connectedAppMentions, invocationTokenPosition).map((mention) => ({
      end: mention.end,
      kind: "connected-app" as const,
      mention,
      start: mention.start,
    })),
  ].sort((left, right) => left.start - right.start || right.end - left.end);

  const ranges: ComposerInlineVisualRange[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    ranges.push(candidate);
    cursor = candidate.end;
  }
  return ranges;
}

function inlineVisualSignature(
  prompt: string,
  invocationTokenPosition: number | null,
  connectedAppMentions: ConnectedAppMentionOption[],
): string {
  return inlineVisualRanges(prompt, invocationTokenPosition, connectedAppMentions)
    .map((range) =>
      range.kind === "repo"
        ? `${range.start}:${range.end}:repo:${range.link.provider}:${range.link.label}:${range.link.url}`
        : `${range.start}:${range.end}:connected-app:${range.mention.provider}:${range.mention.text}:${range.mention.displayText}`,
    )
    .join("|");
}

function rebuildEditorDom(
  root: HTMLElement,
  prompt: string,
  token: ComposerInlineToken | null,
  connectedAppMentions: ConnectedAppMentionOption[],
) {
  const position = tokenPosition(token, prompt);
  const visualRanges = inlineVisualRanges(prompt, position, connectedAppMentions);
  let tokenInserted = false;

  function appendText(value: string) {
    if (value) root.append(document.createTextNode(value));
  }

  function appendPromptRange(start: number, end: number) {
    if (!token || position === null || tokenInserted || position < start || position > end) {
      appendText(prompt.slice(start, end));
      return;
    }
    appendText(prompt.slice(start, position));
    root.append(createTokenElement(token));
    tokenInserted = true;
    appendText(prompt.slice(position, end));
  }

  root.replaceChildren();

  let cursor = 0;
  for (const range of visualRanges) {
    appendPromptRange(cursor, range.start);
    if (range.kind === "repo") {
      root.append(createRepoLinkElement(range.link));
    } else {
      root.append(createConnectedAppMentionElement(range.mention));
    }
    cursor = range.end;
  }
  appendPromptRange(cursor, prompt.length);
  if (token && !tokenInserted) root.append(createTokenElement(token));
}

export const ComposerInlineInput = forwardRef<ComposerInlineInputHandle, {
  connectedAppMentions?: ConnectedAppMentionOption[];
  disabled: boolean;
  onCursorChange: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPromptChange: (value: string, cursorIndex: number) => void;
  onTokenPositionChange: (position: number | null) => void;
  placeholder: string;
  prompt: string;
  token: ComposerInlineToken | null;
}>(function ComposerInlineInput({
  connectedAppMentions = [],
  disabled,
  onCursorChange,
  onKeyDown,
  onPromptChange,
  onTokenPositionChange,
  placeholder,
  prompt,
  token,
}, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nextViewSelectionRef = useRef<number | null>(null);
  const tokenSignature = token ? `${token.key}:${tokenPosition(token, prompt) ?? 0}` : "none";
  const visualSignature = `${tokenSignature}|${inlineVisualSignature(prompt, tokenPosition(token, prompt), connectedAppMentions)}`;
  const previousVisualSignatureRef = useRef<string | null>(null);
  const isEmpty = prompt.length === 0 && !token;

  useImperativeHandle(ref, () => ({
    get element() {
      return rootRef.current;
    },
    focusAtPromptIndex(index, options) {
      const root = rootRef.current;
      if (!root) return;
      const viewIndex = viewIndexFromPromptIndex(index, token, prompt, options?.afterToken);
      nextViewSelectionRef.current = viewIndex;
      root.focus();
      setSelectionByViewIndex(root, viewIndex);
      resizeComposerTextarea(root);
    },
    resize() {
      resizeComposerTextarea(rootRef.current);
    },
  }), [prompt, token]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const visualChanged = previousVisualSignatureRef.current !== visualSignature;
    previousVisualSignatureRef.current = visualSignature;
    const currentState = extractEditorState(root);
    const shouldRebuild =
      visualChanged ||
      prompt === "" ||
      currentState.text !== prompt ||
      currentState.tokenPosition !== tokenPosition(token, prompt);
    if (shouldRebuild) {
      rebuildEditorDom(root, prompt, token, connectedAppMentions);
      root.dataset.empty = prompt.length === 0 && !token ? "true" : "false";
    }
    resizeComposerTextarea(root);
    if (document.activeElement !== root || nextViewSelectionRef.current === null) return;
    setSelectionByViewIndex(root, nextViewSelectionRef.current);
  }, [connectedAppMentions, prompt, token, visualSignature]);

  function syncFromDom() {
    const root = rootRef.current;
    if (!root) return;
    const nextViewIndex = selectionViewIndex(root);
    const nextState = extractEditorState(root);
    const nextCursor = promptIndexFromViewIndex(nextViewIndex, token, nextState.text);
    nextViewSelectionRef.current = nextViewIndex;
    root.dataset.empty = nextState.text.length === 0 && !token ? "true" : "false";
    onTokenPositionChange(nextState.tokenPosition);
    onCursorChange(nextCursor);
    onPromptChange(nextState.text, nextCursor);
  }

  function syncAfterProgrammaticInsert() {
    syncFromDom();
    window.requestAnimationFrame(syncFromDom);
  }

  function updateCursorFromSelection() {
    const root = rootRef.current;
    if (!root) return;
    const nextViewIndex = selectionViewIndex(root);
    nextViewSelectionRef.current = nextViewIndex;
    onCursorChange(promptIndexFromViewIndex(nextViewIndex, token, prompt));
  }

  return (
    <div
      ref={rootRef}
      className="composer-inline-input"
      role="textbox"
      aria-multiline="true"
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-empty={isEmpty ? "true" : "false"}
      data-placeholder={placeholder}
      onBeforeInput={(event) => {
        if ((event.nativeEvent as InputEvent).inputType !== "insertParagraph") return;
        event.preventDefault();
        insertPlainText("\n");
        syncAfterProgrammaticInsert();
      }}
      onInput={syncFromDom}
      onKeyDown={(event) => {
        onKeyDown(event);
      }}
      onKeyUp={updateCursorFromSelection}
      onMouseUp={updateCursorFromSelection}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        insertPlainText(text);
        syncAfterProgrammaticInsert();
      }}
    />
  );
});
