import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import { resizeComposerTextarea } from "./ComposerLayout";

const INLINE_TOKEN_SELECTOR = "[data-inline-token='true']";

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
    if (isInlineToken(node)) {
      index += 1;
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
    if (isInlineToken(node)) {
      if (remaining <= 0) {
        placeBefore(node);
        return true;
      }
      remaining -= 1;
      if (remaining <= 0) {
        placeAfter(node);
        return true;
      }
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

function rebuildEditorDom(root: HTMLElement, prompt: string, token: ComposerInlineToken | null) {
  const position = tokenPosition(token, prompt);
  root.replaceChildren();
  if (position === null || !token) {
    if (prompt) root.append(document.createTextNode(prompt));
    return;
  }
  const before = prompt.slice(0, position);
  const after = prompt.slice(position);
  if (before) root.append(document.createTextNode(before));
  root.append(createTokenElement(token));
  if (after) root.append(document.createTextNode(after));
}

export const ComposerInlineInput = forwardRef<ComposerInlineInputHandle, {
  disabled: boolean;
  onCursorChange: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPromptChange: (value: string, cursorIndex: number) => void;
  onTokenPositionChange: (position: number | null) => void;
  placeholder: string;
  prompt: string;
  token: ComposerInlineToken | null;
}>(function ComposerInlineInput({
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
  const previousTokenSignatureRef = useRef<string | null>(null);
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
    const tokenChanged = previousTokenSignatureRef.current !== tokenSignature;
    previousTokenSignatureRef.current = tokenSignature;
    const currentState = extractEditorState(root);
    const shouldRebuild =
      tokenChanged ||
      prompt === "" ||
      (document.activeElement !== root && (currentState.text !== prompt || currentState.tokenPosition !== tokenPosition(token, prompt)));
    if (shouldRebuild) {
      rebuildEditorDom(root, prompt, token);
      root.dataset.empty = prompt.length === 0 && !token ? "true" : "false";
    }
    resizeComposerTextarea(root);
    if (document.activeElement !== root || nextViewSelectionRef.current === null) return;
    setSelectionByViewIndex(root, nextViewSelectionRef.current);
  }, [prompt, token]);

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
      }}
      onInput={syncFromDom}
      onKeyDown={(event) => {
        onKeyDown(event);
      }}
      onKeyUp={updateCursorFromSelection}
      onMouseUp={updateCursorFromSelection}
      onPaste={(event) => {
        event.preventDefault();
        insertPlainText(event.clipboardData.getData("text/plain"));
      }}
    />
  );
});
