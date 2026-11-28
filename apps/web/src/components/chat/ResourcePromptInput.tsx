import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ResourcePromptBody, ResourceSetupPart } from "../../lib/resource-setup-prompt";

type Field = Exclude<ResourceSetupPart, string>;
type Slot = { field: Field["field"]; host: HTMLElement };

function appendText(body: ResourcePromptBody, text: string) {
  if (!text) return;
  const previous = body.at(-1);
  if (typeof previous === "string") body[body.length - 1] = previous + text;
  else body.push(text);
}

function visitPrompt(root: HTMLElement, fields: Map<string, Field>, emit: (part: ResourcePromptBody[number], node: Node) => void) {
  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) emit(node.textContent, node);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const field = fields.get(node.dataset.resourceField ?? "");
    if (field) {
      emit({ field: field.field }, node);
      return;
    }
    if (node.tagName === "BR") {
      // Chromium leaves a trailing BR as a caret stop after deleting prose next
      // to a non-editable span. A real final line break has its own preceding BR.
      if (node.nextSibling) emit("\n", node);
      return;
    }
    if (node !== root && (node.tagName === "DIV" || node.tagName === "P") && node.previousSibling) emit("\n", node);
    node.childNodes.forEach(visit);
  }
  visit(root);
}

type PromptDeletion = { node: Node; start: number; end: number };

function readBody(root: HTMLElement, fields: Map<string, Field>, deletion?: PromptDeletion) {
  const body: ResourcePromptBody = [];
  const slots: Slot[] = [];
  let length = 0;
  let omittedOffset: number | null = null;
  visitPrompt(root, fields, (part, node) => {
    if (deletion && node === deletion.node) {
      omittedOffset = length + deletion.start;
      if (typeof part !== "string") return;
      part = part.slice(0, deletion.start) + part.slice(deletion.end);
    }
    if (typeof part === "string") {
      appendText(body, part);
      length += part.length;
    } else {
      body.push(part);
      slots.push({ field: part.field, host: node as HTMLElement });
      length++;
    }
  });
  return { body, slots, omittedOffset };
}

function placeCaret(root: HTMLElement, fields: Map<string, Field>, index: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  let offset = 0;
  let placed = false;
  visitPrompt(root, fields, (part, node) => {
    if (placed) return;
    const length = typeof part === "string" ? part.length : 1;
    if (index <= offset + length) {
      if (node.nodeType === Node.TEXT_NODE) range.setStart(node, Math.max(0, index - offset));
      else if (index <= offset) range.setStartBefore(node);
      else if (typeof part !== "string" || node.nodeName === "BR") range.setStartAfter(node);
      else range.setStart(node, 0);
      range.collapse(true);
      placed = true;
    }
    offset += length;
  });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function deletionAtCaret(root: HTMLElement, backward: boolean): PromptDeletion | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  const offset = range.startOffset;
  if (!root.contains(container)) return null;
  const element = container instanceof Element ? container : container.parentElement;
  const inside = element?.closest<HTMLElement>("[data-resource-field]");
  if (inside) return { node: inside, start: 0, end: 1 };

  // Chromium can skip whitespace adjoining an inline widget. Give that
  // whitespace an exact range; the browser handles ordinary prose itself.
  function whitespace(node: Node, start: number): PromptDeletion | null {
    const char = node.textContent?.charAt(start);
    return char && /\s/u.test(char) ? { node, start, end: start + 1 } : null;
  }
  function neighbor(node: Node): Node | null {
    for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
      const next = backward ? current.previousSibling : current.nextSibling;
      if (next) return next;
      if (current.nodeName === "DIV" || current.nodeName === "P") break;
    }
    return null;
  }
  let node: Node | null;
  if (container.nodeType === Node.TEXT_NODE) {
    if (backward ? offset > 0 : offset < (container.textContent?.length ?? 0))
      return whitespace(container, backward ? offset - 1 : offset);
    node = neighbor(container);
  } else node = container.childNodes[backward ? offset - 1 : offset] ?? neighbor(container);
  while (node) {
    if (node instanceof HTMLElement && (node.hasAttribute("data-resource-field") || (node.nodeName === "BR" && node.nextSibling)))
      return { node, start: 0, end: 1 };
    if (node.nodeType === Node.TEXT_NODE && node.textContent)
      return whitespace(node, backward ? node.textContent.length - 1 : 0);
    if (node.nodeName === "DIV" || node.nodeName === "P") return null;
    node = (backward ? node.lastChild : node.firstChild) ?? neighbor(node);
  }
  return null;
}

export function ResourcePromptInput({ parts, template, disabled, editorRef, renderField, fieldLabel, onEdit, onSubmit, onPasteFiles }: {
  parts: ResourceSetupPart[];
  template: ResourceSetupPart[];
  disabled: boolean;
  editorRef: RefObject<HTMLDivElement | null>;
  renderField(part: Field): ReactNode;
  fieldLabel(part: Field): string;
  onEdit(body: ResourcePromptBody): void;
  onSubmit(queue: boolean): void;
  onPasteFiles(files: File[]): void;
}) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const fields = new Map<string, Field>();
  for (const part of template) if (typeof part !== "string") fields.set(part.field, part);
  const desired: ResourcePromptBody = [];
  for (const part of parts) {
    if (typeof part === "string") appendText(desired, part);
    else {
      desired.push({ field: part.field });
    }
  }
  // The browser owns prose and selection. React only mounts controls inside
  // non-editable spans, so typing never replaces a focused DOM text node.
  const lastBody = useRef("");
  const nativeDeleteInProgress = useRef(false);
  const caretAfterEdit = useRef<number | null>(null);
  const bodyKey = JSON.stringify(desired);
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    if (lastBody.current !== bodyKey) {
      // Keep retained badges mounted when a choice changes the sentence. Replacing
      // the focused trigger sends the next keyboard event to the page body.
      const retained = new Map(readBody(root, fields).slots.map(slot => [slot.field, slot.host]));
      const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
        ? document.activeElement : null;
      let cursor = root.firstChild;
      for (const part of desired) {
        let node: Node;
        if (typeof part === "string") {
          node = cursor?.nodeType === Node.TEXT_NODE ? cursor : document.createTextNode(part);
          if (node.textContent !== part) node.textContent = part;
        } else {
          const host = retained.get(part.field) ?? document.createElement("span");
          host.contentEditable = "false";
          host.dataset.resourceField = part.field;
          node = host;
        }
        if (cursor === node) cursor = cursor.nextSibling;
        else root.insertBefore(node, cursor);
      }
      while (cursor) {
        const next = cursor.nextSibling;
        cursor.remove();
        cursor = next;
      }
      if (focused?.isConnected && document.activeElement === document.body) focused.focus({ preventScroll: true });
      lastBody.current = bodyKey;
    }
    if (caretAfterEdit.current !== null) {
      if (document.activeElement === root) placeCaret(root, fields, caretAfterEdit.current);
      caretAfterEdit.current = null;
    }
    const current = readBody(root, fields).slots;
    if (current.length !== slots.length || current.some((slot, index) => slot.host !== slots[index]?.host)) setSlots(current);
  });

  function copySelection(event: ClipboardEvent<HTMLDivElement>, cut: boolean) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || event.target !== event.currentTarget) return;
    const range = selection.getRangeAt(0);
    if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
    const fragment = document.createElement("div");
    fragment.append(range.cloneContents());
    const { body } = readBody(fragment, fields);
    event.clipboardData.setData("text/plain", body.map(part =>
      typeof part === "string" ? part : fieldLabel(fields.get(part.field)!)).join(""));
    event.preventDefault();
    if (cut && !disabled) document.execCommand("delete");
  }

  function handleFieldKey(event: KeyboardEvent<HTMLDivElement>) {
    const root = editorRef.current;
    if (!root || disabled || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
      !(event.target instanceof HTMLElement) || !root.contains(event.target)) return;
    const remove = event.key === "Backspace" || event.key === "Delete";
    const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!remove && !arrow) return;
    const backward = event.key === "Backspace" || event.key === "ArrowLeft";
    const target = event.target;
    if (target.closest('[role="menu"]') && (!remove || target instanceof HTMLInputElement)) return;
    const host = target.closest<HTMLElement>("[data-resource-field]");
    const deletion = host ? { node: host, start: 0, end: 1 }
      : remove && target === root ? deletionAtCaret(root, backward) : null;
    if (!deletion || (arrow && event.shiftKey)) return;
    if (target instanceof HTMLInputElement && (target.selectionStart !== target.selectionEnd ||
      target.selectionStart !== (backward ? 0 : target.value.length))) return;
    event.preventDefault();
    event.stopPropagation();
    root.focus();
    const range = document.createRange();
    if (deletion.node.nodeType === Node.TEXT_NODE) {
      range.setStart(deletion.node, deletion.start);
      range.setEnd(deletion.node, deletion.end);
    } else range.selectNode(deletion.node);
    if (arrow) range.collapse(backward);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (remove) {
      const intended = readBody(root, fields, deletion);
      // Let the editor record a native undo entry. At adjacent widgets Chromium
      // can also remove a line break while normalizing the DOM. Commit only the
      // intended deletion and restore the insertion point in the resulting text.
      nativeDeleteInProgress.current = true;
      try { document.execCommand("delete"); }
      finally { nativeDeleteInProgress.current = false; }
      if (deletion.node instanceof HTMLElement && deletion.node.hasAttribute("data-resource-field") && root.contains(deletion.node))
        deletion.node.remove();
      lastBody.current = JSON.stringify(readBody(root, fields).body);
      caretAfterEdit.current = intended.omittedOffset;
      onEdit(intended.body);
    }
  }

  return <div onKeyDownCapture={handleFieldKey}>
    <div ref={editorRef} className="resource-setup-sentence resource-prompt-input" role="textbox"
      aria-label="Resource prompt" aria-multiline="true" aria-disabled={disabled} tabIndex={0}
      contentEditable={!disabled} suppressContentEditableWarning
      onInput={event => {
        if (nativeDeleteInProgress.current || event.target !== event.currentTarget) return;
        const { body } = readBody(event.currentTarget, fields);
        lastBody.current = JSON.stringify(body);
        onEdit(body);
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit(event.ctrlKey || event.metaKey);
        }
      }}
      onCopy={event => copySelection(event, false)}
      onCut={event => copySelection(event, true)}
      onPaste={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (event.clipboardData.files.length) onPasteFiles(Array.from(event.clipboardData.files));
        else document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
      }}
      onDrop={event => {
        // Keep foreign HTML out of the editable DOM; the composer handles files.
        if (!event.dataTransfer.files.length) event.preventDefault();
      }}
    />
    {slots.map(({ field, host }) => {
      const part = fields.get(field);
      return part ? createPortal(renderField(part), host, field) : null;
    })}
  </div>;
}
