import type { CSSProperties } from "react";

const COMPOSER_MAX_VISIBLE_LINES = 10;
const SLASH_MENU_WIDTH_PX = 340;

function cssPixelValue(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resizeComposerTextarea(textarea: HTMLElement | null) {
  if (!textarea) return;

  textarea.style.height = "auto";

  const styles = window.getComputedStyle(textarea);
  const fontSize = cssPixelValue(styles.fontSize, 16);
  const lineHeight = cssPixelValue(styles.lineHeight, fontSize * 1.45);
  const paddingBlock = cssPixelValue(styles.paddingTop) + cssPixelValue(styles.paddingBottom);
  const borderBlock = cssPixelValue(styles.borderTopWidth) + cssPixelValue(styles.borderBottomWidth);
  const minHeight = cssPixelValue(styles.minHeight, 66);
  const maxHeight = Math.max(
    minHeight,
    Math.ceil(lineHeight * COMPOSER_MAX_VISIBLE_LINES + paddingBlock + borderBlock),
  );
  const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function slashMenuAnchorStyle(textarea: HTMLElement, root: HTMLElement): CSSProperties {
  const textareaRect = textarea.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const styles = window.getComputedStyle(textarea);
  const paddingLeft = cssPixelValue(styles.paddingLeft, 14);
  const paddingTop = cssPixelValue(styles.paddingTop, 15);
  const availableWidth = Math.max(0, rootRect.width - 16);
  const menuWidth = Math.min(SLASH_MENU_WIDTH_PX, availableWidth);
  const rawLeft = textareaRect.left - rootRect.left + paddingLeft - 8;
  const left = Math.max(8, Math.min(rawLeft, rootRect.width - menuWidth - 8));
  const top = Math.max(8, textareaRect.top - rootRect.top + paddingTop + 2);
  return {
    left,
    top,
    width: menuWidth,
  };
}
