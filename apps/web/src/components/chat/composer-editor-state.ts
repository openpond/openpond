export type ComposerEditorState = { text: string; tokenPosition: number | null };

/** Read the logical prompt, including Chromium's contenteditable line wrappers.
 * Kept browser-only and self-contained so desktop automation uses the same
 * payload boundary instead of approximating it with textContent/innerText. */
export function readComposerEditorState(root: Node): ComposerEditorState {
  let text = "";
  let tokenPosition: number | null = null;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node instanceof HTMLElement) {
      if (node.matches('[data-inline-token="true"]')) {
        tokenPosition = text.length;
        continue;
      }
      if (node.matches('[data-inline-repo-link="true"]')) {
        text += node.dataset.repoUrl ?? "";
        continue;
      }
      if (node.matches('[data-inline-connected-app-mention="true"]')) {
        text += node.dataset.connectedMentionText ?? "";
        continue;
      }
      if (node !== root && (node.tagName === "DIV" || node.tagName === "P")) {
        let previous = node.previousSibling;
        while (previous && (
          (previous instanceof HTMLElement && previous.matches('[data-inline-token="true"]')) ||
          (previous.nodeType === Node.TEXT_NODE && previous.textContent === "")
        )) previous = previous.previousSibling;
        if (previous) text += "\n";
      }
      if (node.tagName === "BR") {
        // A sole BR is Chromium's empty-line caret placeholder. The wrapper
        // supplies its line boundary; counting both introduces a blank line.
        if (node.parentNode?.childNodes.length !== 1) text += "\n";
        continue;
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      continue;
    }
    for (let index = node.childNodes.length - 1; index >= 0; index--) {
      pending.push(node.childNodes[index]!);
    }
  }
  return { text, tokenPosition };
}
