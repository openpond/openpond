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

function readBody(root: HTMLElement, fields: Map<string, Field>) {
  const body: ResourcePromptBody = [];
  const slots: Slot[] = [];
  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(body, node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const field = fields.get(node.dataset.resourceField ?? "");
    if (field) {
      body.push({ field: field.field });
      slots.push({ field: field.field, host: node });
      return;
    }
    if (node.tagName === "BR") {
      if (node.parentNode?.childNodes.length !== 1) appendText(body, "\n");
      return;
    }
    if (node !== root && (node.tagName === "DIV" || node.tagName === "P") && node.previousSibling) appendText(body, "\n");
    node.childNodes.forEach(visit);
  }
  visit(root);
  return { body, slots };
}

function adjacentField(root: HTMLElement, backward: boolean) {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  let node: Node | null = range.startContainer;
  const offset = range.startOffset;
  if (!root.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    if (backward ? offset !== 0 : offset !== node.textContent?.length) return null;
    node = backward ? node.previousSibling : node.nextSibling;
  } else node = node.childNodes[backward ? offset - 1 : offset] ?? null;
  while (node?.nodeType === Node.TEXT_NODE && !node.textContent) node = backward ? node.previousSibling : node.nextSibling;
  return node instanceof HTMLElement && node.hasAttribute("data-resource-field") ? node : null;
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
  const bodyKey = JSON.stringify(desired);
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    if (lastBody.current !== bodyKey) {
      const fragment = document.createDocumentFragment();
      for (const part of desired) {
        if (typeof part === "string") fragment.append(part);
        else {
          const host = document.createElement("span");
          host.contentEditable = "false";
          host.dataset.resourceField = part.field;
          fragment.append(host);
        }
      }
      root.replaceChildren(fragment);
      lastBody.current = bodyKey;
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
      !(event.target instanceof HTMLElement) || !root.contains(event.target) || event.target.closest('[role="menu"]')) return;
    const remove = event.key === "Backspace" || event.key === "Delete";
    const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!remove && !arrow) return;
    const backward = event.key === "Backspace" || event.key === "ArrowLeft";
    const target = event.target;
    const focused = target.closest<HTMLElement>("[data-resource-field]");
    const host = focused ?? (remove && target === root ? adjacentField(root, backward) : null);
    if (!host || !host.parentNode || (arrow && event.shiftKey)) return;
    if (target instanceof HTMLInputElement && (target.selectionStart !== target.selectionEnd ||
      target.selectionStart !== (backward ? 0 : target.value.length))) return;
    event.preventDefault();
    event.stopPropagation();
    root.focus();
    const range = document.createRange();
    range.selectNode(host);
    if (arrow) range.collapse(backward);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (remove) {
      // Native deletion records an undo entry and leaves the caret at the badge.
      document.execCommand("delete");
      if (root.contains(host)) {
        range.deleteContents();
        const { body } = readBody(root, fields);
        lastBody.current = JSON.stringify(body);
        onEdit(body);
      }
    }
  }

  return <div onKeyDownCapture={handleFieldKey}>
    <div ref={editorRef} className="resource-setup-sentence resource-prompt-input" role="textbox"
      aria-label="Resource prompt" aria-multiline="true" aria-disabled={disabled} tabIndex={0}
      contentEditable={!disabled} suppressContentEditableWarning
      onInput={event => {
        if (event.target !== event.currentTarget) return;
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
